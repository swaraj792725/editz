#!/usr/bin/env node
/**
 * Editz daemon: MCP server on stdio for Claude + WebSocket bridge for Premiere panels.
 * stdout belongs to MCP. Log to stderr only.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertProject, parseProject, PPRO_TICKS_PER_SECOND, secondsToFrames } from "@editz/ir";
import type { RawSequence } from "@editz/compilers";
import { Bridge } from "./bridge.ts";
import { buildSequence } from "./build.ts";
import { scanFolder } from "./organize.ts";
import { ensureToken, supportDir, workDir } from "./paths.ts";
import { probe } from "./probe.ts";
import { keepRanges, silenceCutProject } from "./edit/silence-cut.ts";
import { analyze, collectMedia, ingest, summarize } from "./media/analyze.ts";
import { contactSheet } from "./media/ffmpeg.ts";
import { MediaIndex } from "./media/index-db.ts";
import { mergeReports, qcCaptions, qcProject, qcRender, QC_TARGETS } from "./qc.ts";
import { PyWorker, defaultWorkerCommand } from "./worker.ts";
import { describeVoices, fillerCutPlan, loadIr, saveIr, speakScript, stemOf, transcribeFile, writeCaptions } from "./speech/service.ts";
import { findFillers, tidyWords, wordsOnTimeline, type Word } from "./speech/transcript.ts";
import { buildCues } from "./speech/captions.ts";
import { placeVoiceover } from "./edit/voiceover.ts";
import { applyDucking, musicTracks } from "./edit/mix.ts";

const log = (m: string) => process.stderr.write(`[editz] ${m}\n`);
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ ...text(msg), isError: true });

const token = ensureToken();
const bridge = new Bridge({ token, port: Number(process.env.EDITZ_PORT ?? 47800), log });
let bridgeError: string | null = null;
try {
  await bridge.start();
  log(`bridge listening on ws://127.0.0.1:${bridge.port}/premiere`);
} catch (e) {
  bridgeError = `Bridge could not start (${(e as Error).message}). Is another Editz already running?`;
  log(bridgeError);
}

const server = new McpServer({ name: "editz", version: "0.0.1" });

server.registerTool(
  "editz_status",
  {
    title: "Editz status",
    description: "Which Premiere Pro versions are installed, whether the Editz panel is connected, and how timelines will be built right now.",
    inputSchema: {},
  },
  async () => text({ ...probe(bridge.connected), bridgeError, supportDir: supportDir(), workDir: workDir() }),
);

server.registerTool(
  "organize_project",
  {
    title: "Organise media into bins",
    description:
      "Scan a folder and sort every media file into the standard Editz bins (01 A-ROLL … 99 UNSORTED). Dry run by default; with apply=true and the panel connected, creates the bins in Premiere and imports each file into its bin. Files on disk are never moved.",
    inputSchema: {
      folder: z.string().describe("Absolute path to the footage folder"),
      apply: z.boolean().default(false).describe("Actually import into Premiere"),
    },
  },
  async ({ folder, apply }) => {
    const plan = scanFolder(folder);
    const summary = Object.fromEntries(Object.entries(plan.byBin).map(([b, f]) => [b, f.length]));
    const lowConfidence = plan.items.filter((i) => i.confidence < 0.5).map((i) => ({ path: i.path, reason: i.reason }));
    if (!apply) return text({ applied: false, summary, lowConfidence, items: plan.items, skipped: plan.skipped });
    if (bridge.connected?.backend !== "cep") return fail("Premiere panel (CEP) not connected, so nothing was imported. Run editz_status for help, or use apply=false to just see the plan.");
    await bridge.request("ensureBins", { paths: Object.keys(plan.byBin) });
    const results: Record<string, boolean> = {};
    for (const [bin, files] of Object.entries(plan.byBin)) {
      const r = await bridge.request<{ ok: boolean }>("importFiles", { paths: files, bin }, 600_000);
      results[bin] = r.ok;
    }
    return text({ applied: true, summary, importOk: results, lowConfidence });
  },
);

server.registerTool(
  "build_sequence",
  {
    title: "Build a timeline in Premiere",
    description:
      "Build a sequence from an Editz Timeline IR (v1). With the CEP panel connected: imports, files clips into bins and reads the timeline back to prove it matches. Otherwise writes an FCP7 XML that any Premiere version can import and says which menu to click.",
    inputSchema: {
      ir: z.any().optional().describe("Editz IR project object"),
      ir_path: z.string().optional().describe("Path to an IR .json file (instead of ir)"),
      sequence: z.string().optional().describe("Sequence name to build (default: first)"),
      out_dir: z.string().optional(),
    },
  },
  async ({ ir, ir_path, sequence, out_dir }) => {
    const input = ir ?? (ir_path ? JSON.parse(readFileSync(ir_path, "utf8")) : undefined);
    if (!input) return fail("Pass ir or ir_path.");
    const { project, issues } = parseProject(input);
    if (!project || issues.length) return fail("IR is invalid:\n" + issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
    const outDir = out_dir ?? join(workDir(), project.name, "timelines");
    try {
      return text(await buildSequence(project, { bridge, outDir, sequence }));
    } catch (e) {
      return fail(`Build failed: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "readback_sequence",
  {
    title: "Read a timeline back",
    description: "Read clips and markers from a Premiere sequence. Times in seconds, plus frames if fps is given.",
    inputSchema: {
      name: z.string(),
      fps_num: z.number().int().positive().optional(),
      fps_den: z.number().int().positive().optional(),
    },
  },
  async ({ name, fps_num, fps_den }) => {
    if (!bridge.connected) return fail("Premiere panel not connected.");
    const raw = await bridge.request<RawSequence>("readSequence", { name });
    const rate = fps_num ? { num: fps_num, den: fps_den ?? 1 } : null;
    const sec = (t: string) => Number(BigInt(t) * 1000n / BigInt(PPRO_TICKS_PER_SECOND)) / 1000;
    const conv = (t: string) => (rate ? { s: sec(t), f: secondsToFrames(sec(t), rate) } : { s: sec(t) });
    const track = (items: RawSequence["video"][number]) =>
      items.map((c) => ({ name: c.name, path: c.mediaPath, start: conv(c.start), end: conv(c.end), in: conv(c.inPoint) }));
    return text({ name: raw.name, video: raw.video.map(track), audio: raw.audio.map(track), markers: raw.markers.map((m) => ({ name: m.name, at: conv(m.start) })) });
  },
);

server.registerTool(
  "add_markers",
  {
    title: "Add sequence markers",
    description: "Add named markers to a Premiere sequence (e.g. Hook, CTA, beat points).",
    inputSchema: {
      sequence: z.string(),
      markers: z.array(z.object({ seconds: z.number().min(0), name: z.string(), comment: z.string().default(""), duration_seconds: z.number().min(0).default(0) })),
    },
  },
  async ({ sequence, markers }) => {
    if (!bridge.connected) return fail("Premiere panel not connected.");
    const r = await bridge.request("addMarkers", {
      sequence,
      markers: markers.map((m) => ({ seconds: m.seconds, name: m.name, comment: m.comment, durationSeconds: m.duration_seconds })),
    });
    return text(r);
  },
);

server.registerTool(
  "export_sequence",
  {
    title: "Export a sequence",
    description: "Render a sequence to a file with a Premiere/Media Encoder preset (.epr). Blocks until Premiere finishes.",
    inputSchema: { sequence: z.string(), out_path: z.string(), preset_path: z.string() },
  },
  async ({ sequence, out_path, preset_path }) => {
    if (!bridge.connected) return fail("Premiere panel not connected.");
    return text(await bridge.request("exportSequence", { sequence, outPath: out_path, presetPath: preset_path }, 3_600_000));
  },
);

// ───────────────────────── M1 S1: media foundation ─────────────────────────

let mediaIndex: MediaIndex | undefined;
const index = () => (mediaIndex ??= new MediaIndex());

server.registerTool(
  "ingest_media",
  {
    title: "Ingest media",
    description:
      "Read every media file in the given folders/files once (duration, size, frame rate, audio) and remember it by content, so later analysis is instant. Files are never changed.",
    inputSchema: {
      paths: z.array(z.string()).min(1).describe("Absolute file or folder paths"),
      max_files: z.number().int().positive().max(20000).default(2000),
    },
  },
  async ({ paths, max_files }) => {
    try {
      const files = collectMedia(paths, max_files);
      const out = [];
      const errors: { path: string; error: string }[] = [];
      for (const f of files) {
        try {
          const m = await ingest(index(), f);
          out.push(summarize({ checksum: m.checksum, path: f, info: m.info, cached: [] }));
        } catch (e) {
          errors.push({ path: f, error: (e as Error).message });
        }
      }
      return text({ files: out.length, media: out, errors, index: index().stats() });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "analyze_media",
  {
    title: "Analyse media",
    description:
      "Measure silence (dead air), loudness (LUFS / true peak) and shot cuts for media files. Runs in the background at low priority and caches by content, so repeat calls are free. Returns compact summaries; set detail=true for raw ranges.",
    inputSchema: {
      paths: z.array(z.string()).min(1),
      kinds: z.array(z.enum(["silence", "loudness", "scenes"])).default(["silence", "loudness", "scenes"]),
      silence_db: z.number().max(0).default(-35).describe("Silence threshold, dBFS"),
      min_silence_s: z.number().positive().default(0.5),
      scene_threshold: z.number().min(0.05).max(0.9).default(0.35),
      detail: z.boolean().default(false),
    },
  },
  async ({ paths, kinds, silence_db, min_silence_s, scene_threshold, detail }) => {
    try {
      const files = collectMedia(paths);
      const results = [];
      for (const f of files) {
        const a = await analyze(index(), f, kinds, { thresholdDb: silence_db, minSilenceSec: min_silence_s, sceneThreshold: scene_threshold });
        results.push(detail ? { ...summarize(a), silence: a.silence, scenes: a.scenes, loudness: a.loudness, cached: a.cached } : { ...summarize(a), cached: a.cached });
      }
      return text({ files: results.length, results });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "contact_sheet",
  {
    title: "Contact sheet",
    description: "A small grid of frames from a video (up to 24) so Claude can see it cheaply. Evenly spaced, or at given times.",
    inputSchema: {
      path: z.string(),
      count: z.number().int().min(1).max(24).default(12),
      times: z.array(z.number().min(0)).max(24).optional().describe("Seconds; overrides count"),
      cols: z.number().int().min(1).max(8).default(4),
    },
  },
  async ({ path, count, times, cols }) => {
    try {
      const m = await ingest(index(), path);
      if (!m.info.hasVideo) return fail("No picture in this file.");
      const dir = join(workDir(), ".cache", "sheets");
      mkdirSync(dir, { recursive: true });
      const out = join(dir, `${m.checksum}-${times ? times.join("_").slice(0, 60) : count}-${cols}.jpg`);
      const sheet = await contactSheet(path, m.info.durationSec, out, { count, times, cols, tileWidth: 320 });
      return {
        content: [
          { type: "image" as const, data: readFileSync(sheet.path).toString("base64"), mimeType: "image/jpeg" },
          { type: "text" as const, text: JSON.stringify({ path: sheet.path, times_s: sheet.times, grid: `${sheet.cols}x${sheet.rows}`, order: "left→right, top→bottom" }) },
        ],
      };
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "remove_silence",
  {
    title: "Remove dead air",
    description:
      "Cut the silent parts out of a talk, interview or podcast recording and build the tight version as a new sequence (any Premiere version). Keeps a little breathing room around speech. Use preview=true to see the numbers without building.",
    inputSchema: {
      path: z.string().describe("Source recording"),
      silence_db: z.number().max(0).default(-35),
      min_silence_s: z.number().positive().default(0.6),
      pad_s: z.number().min(0).max(1).default(0.15),
      min_keep_s: z.number().min(0).default(0.4),
      merge_gap_s: z.number().min(0).default(0.3),
      sequence: z.string().optional(),
      preview: z.boolean().default(false),
      out_dir: z.string().optional(),
    },
  },
  async (a) => {
    try {
      const r = await analyze(index(), a.path, ["silence"], { thresholdDb: a.silence_db, minSilenceSec: a.min_silence_s });
      if (!r.info.hasAudio) return fail("This file has no audio, so there is no silence to find.");
      const keep = keepRanges(r.silence ?? [], r.info.durationSec, { padSec: a.pad_s, minKeepSec: a.min_keep_s, mergeGapSec: a.merge_gap_s });
      if (!keep.length) return fail("Everything is below the silence threshold. Try a lower silence_db (e.g. -45).");
      const { project: input, stats } = silenceCutProject(r.info, keep, a.sequence);
      if (a.preview) return text({ preview: true, stats, keep_ranges_s: keep.slice(0, 50) });
      const project = parseProject(input).project!;
      const qc = qcProject(project);
      const outDir = a.out_dir ?? join(workDir(), project.name, "timelines");
      const built = await buildSequence(project, { bridge, outDir });
      return text({ stats, qc, build: built, ir_path: saveIr(project, built.xmlPath) });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "run_qc",
  {
    title: "Quality check",
    description:
      "Check a timeline (IR) for gaps, offline media, wrong size/length for the platform, and a rendered file for loudness and clipping. Returns blocking problems in plain words.",
    inputSchema: {
      ir: z.any().optional(),
      ir_path: z.string().optional(),
      sequence: z.string().optional(),
      render_path: z.string().optional().describe("Rendered video/audio file to measure"),
      target: z.enum(["any", "youtube", "reels", "shorts", "podcast", "broadcast"]).default("any"),
    },
  },
  async ({ ir, ir_path, sequence, render_path, target }) => {
    try {
      const t = QC_TARGETS[target]!;
      const reports = [];
      const input = ir ?? (ir_path ? JSON.parse(readFileSync(ir_path, "utf8")) : undefined);
      if (input) reports.push(qcProject(input, sequence, t));
      if (render_path) reports.push(await qcRender(render_path, t));
      if (!reports.length) return fail("Pass ir / ir_path and/or render_path.");
      return text(mergeReports(...reports));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

// ───────────────────────── M1 S2: speech, captions, voice-over ─────────────────────────

let worker: PyWorker | undefined;
const py = () => (worker ??= new PyWorker(defaultWorkerCommand));
const transcriptDir = () => join(workDir(), ".cache", "transcripts");

type ToolExtra = { _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> };
/** Worker progress → stderr log + MCP progress notifications (when the client asked for them). */
const progressFor = (extra: ToolExtra, label: string) => {
  const token = extra._meta?.progressToken;
  let n = 0;
  return (message: string, value: number | null) => {
    log(`${label}: ${message}${value != null ? ` ${Math.round(value * 100)}%` : ""}`);
    if (token === undefined) return;
    n++;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message } }).catch(() => {});
  };
};

/** Captions read clean even when the audio keeps an "um". */
const withoutFillers = (words: Word[]) => {
  const hits = findFillers(words).filter((h) => h.kind === "filler");
  return words.filter((w) => !hits.some((h) => (w.start + w.end) / 2 >= h.start && (w.start + w.end) / 2 <= h.end));
};

const captionShape = {
  max_chars: z.number().int().min(16).max(80).default(42).describe("Characters per line"),
  max_lines: z.number().int().min(1).max(3).default(2),
  max_cps: z.number().min(8).max(30).default(17).describe("Reading speed, characters a second"),
};

server.registerTool(
  "transcribe",
  {
    title: "Transcribe",
    description:
      "Speech to text with word timings, on this Mac (Whisper; nothing is uploaded). Keeps 'um'/'uh' so they can be cut. Cached by file content, so repeat calls are instant. First use downloads the model (~1.6 GB).",
    inputSchema: {
      path: z.string(),
      language: z.string().optional().describe("ISO code like 'en'; omit to detect"),
      model: z.string().optional().describe("Hugging Face MLX Whisper repo; default large-v3-turbo"),
      verbatim: z.boolean().default(true),
      words: z.boolean().default(false).describe("Return every word with timings (large)"),
    },
  },
  async (a, extra) => {
    try {
      const t = await transcribeFile(index(), py(), a.path, transcriptDir(), { ...a, onProgress: progressFor(extra, "transcribe") });
      const tr = t.transcript;
      return text({
        language: tr.language,
        model: tr.model,
        cached: t.cached,
        duration_s: t.info.durationSec,
        words: tr.words.length,
        fillers: findFillers(tr.words).length,
        json_path: t.json_path,
        text: tr.text.length > 4000 ? tr.text.slice(0, 4000) + " …" : tr.text,
        ...(a.words ? { word_timings: tr.words } : { segments: tr.segments.slice(0, 40) }),
      });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "remove_filler",
  {
    title: "Remove ums and dead air",
    description:
      "Cut 'um', 'uh', stutters ('we we') and, by default, silences out of a talk, then build the tight sequence and matching captions (SRT). aggressive=true also cuts comma-wrapped 'like', 'you know', 'I mean'. preview=true shows what would go without building.",
    inputSchema: {
      path: z.string(),
      also_silence: z.boolean().default(true),
      aggressive: z.boolean().default(false),
      extra_fillers: z.array(z.string()).optional().describe("More words to treat as filler"),
      silence_db: z.number().max(0).default(-35),
      min_silence_s: z.number().positive().default(0.6),
      pad_s: z.number().min(0).max(1).default(0.15),
      min_keep_s: z.number().min(0).default(0.4),
      merge_gap_s: z.number().min(0).default(0.3),
      captions: z.boolean().default(true),
      caption_format: z.enum(["srt", "vtt", "both"]).default("srt"),
      ...captionShape,
      sequence: z.string().optional(),
      language: z.string().optional(),
      model: z.string().optional(),
      preview: z.boolean().default(false),
      out_dir: z.string().optional(),
    },
  },
  async (a, extra) => {
    try {
      const t = await transcribeFile(index(), py(), a.path, transcriptDir(), { model: a.model, language: a.language, onProgress: progressFor(extra, "remove_filler") });
      const silence = a.also_silence ? (await analyze(index(), a.path, ["silence"], { thresholdDb: a.silence_db, minSilenceSec: a.min_silence_s })).silence : undefined;
      const plan = fillerCutPlan(t.info, t.transcript.words, {
        silence,
        keep: { padSec: a.pad_s, minKeepSec: a.min_keep_s, mergeGapSec: a.merge_gap_s },
        aggressive: a.aggressive,
        extra: a.extra_fillers,
        sequence: a.sequence,
        captions: { maxChars: a.max_chars, maxLines: a.max_lines, maxCps: a.max_cps },
      });
      const cuts = plan.fillers.map((f) => ({ at_s: f.start, text: f.text, kind: f.kind }));
      if (a.preview) return text({ preview: true, stats: plan.stats, cuts: cuts.slice(0, 80), captions: plan.cues.length });
      const capOpts = { maxChars: a.max_chars, maxLines: a.max_lines, maxCps: a.max_cps };
      const qc = mergeReports(qcProject(plan.project), ...(a.captions ? [qcCaptions(plan.cues, capOpts)] : []));
      const outDir = a.out_dir ?? join(workDir(), plan.project.name, "timelines");
      const built = await buildSequence(plan.project, { bridge, outDir });
      const caption_files = a.captions ? writeCaptions(plan.cues, built.xmlPath, a.caption_format) : [];
      const capStep = caption_files.length ? ` Then File → Import… "${caption_files[0]}" and drag it onto the sequence above V1 (it becomes a caption track).` : "";
      return text({
        stats: plan.stats,
        cuts: cuts.slice(0, 40),
        qc,
        build: { ...built, nextStep: (built.nextStep ?? "Sequence built.") + capStep },
        ir_path: saveIr(plan.project, built.xmlPath),
        caption_files,
      });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "create_captions",
  {
    title: "Create captions",
    description:
      "Captions (SRT/VTT) from a recording, or from a built edit (ir_path) so they follow the cuts. Readable by default: ≤ 2 lines, ≤ 42 characters, ≤ 17 characters a second. Fillers are left out of the text.",
    inputSchema: {
      path: z.string().optional().describe("A recording to caption as it is"),
      ir: z.any().optional(),
      ir_path: z.string().optional().describe("The .editz.json saved next to a built timeline"),
      sequence: z.string().optional(),
      track: z.number().int().min(1).optional().describe("Audio track with the speech (1 = A1); default the first with speech"),
      format: z.enum(["srt", "vtt", "both"]).default("srt"),
      ...captionShape,
      out: z.string().optional().describe("Output path (extension is set by format)"),
      language: z.string().optional(),
      model: z.string().optional(),
    },
  },
  async (a, extra) => {
    try {
      const prog = progressFor(extra, "create_captions");
      const capOpts = { maxChars: a.max_chars, maxLines: a.max_lines, maxCps: a.max_cps };
      let words: Word[];
      let base: string;
      if (a.path) {
        const t = await transcribeFile(index(), py(), a.path, transcriptDir(), { model: a.model, language: a.language, onProgress: prog });
        words = t.transcript.words;
        base = a.out ?? join(workDir(), stemOf(a.path), "captions", stemOf(a.path));
      } else {
        const project = loadIr(a.ir, a.ir_path);
        const seq = a.sequence ? project.sequences.find((s) => s.name === a.sequence) : project.sequences[0];
        if (!seq) return fail(`Sequence not in IR: ${a.sequence}`);
        const ti = a.track !== undefined ? a.track - 1 : seq.audio.findIndex((t) => t.items.length > 0);
        const track = seq.audio[ti];
        if (!track?.items.length) return fail("No audio clips to caption on that track.");
        const transcripts = new Map<string, Word[]>();
        for (const id of new Set(track.items.map((c) => c.media_id))) {
          const m = project.media.find((x) => x.id === id);
          if (!m?.has_audio) continue;
          transcripts.set(id, (await transcribeFile(index(), py(), m.path, transcriptDir(), { model: a.model, language: a.language, onProgress: prog })).transcript.words);
        }
        words = wordsOnTimeline(project, seq, transcripts, ti);
        base = a.out ?? (a.ir_path ? a.ir_path.replace(/\.editz\.json$/i, "") : join(workDir(), project.name, "captions", seq.name));
      }
      mkdirSync(dirname(base), { recursive: true });
      const cues = buildCues(tidyWords(withoutFillers(words)), capOpts);
      const files = writeCaptions(cues, base, a.format);
      return text({ captions: cues.length, files, qc: qcCaptions(cues, capOpts), first: cues.slice(0, 5) });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "list_voices",
  {
    title: "List voices",
    description: "Voices for generate_voiceover (Kokoro, runs on this Mac, free for commercial use). First use downloads ~340 MB.",
    inputSchema: {},
  },
  async (_a, extra) => {
    try {
      const { voices } = await py().call<{ voices: string[] }>("voices", {}, { onProgress: progressFor(extra, "list_voices") });
      return text({ default: "af_heart", voices: describeVoices(voices) });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "generate_voiceover",
  {
    title: "Generate voice-over",
    description:
      "Speak a script with a local AI voice (one WAV per paragraph, loudness-matched). With ir_path it also places the takes on the VO track (A2) and ducks the music under them, then builds the sequence.",
    inputSchema: {
      script: z.string().min(1).describe("Paragraphs separated by blank lines"),
      voice: z.string().default("af_heart"),
      speed: z.number().min(0.5).max(2).default(1),
      lang: z.string().optional().describe("Defaults from the voice (af_* → en-us, bf_* → en-gb…)"),
      ir: z.any().optional(),
      ir_path: z.string().optional(),
      sequence: z.string().optional(),
      start_s: z.number().min(0).default(0),
      gap_s: z.number().min(0).default(0.4).describe("Pause between paragraphs"),
      duck_db: z.number().min(-40).max(0).default(-15).describe("Music level under the voice"),
      out_dir: z.string().optional(),
    },
  },
  async (a, extra) => {
    try {
      const prog = progressFor(extra, "generate_voiceover");
      const hasIr = a.ir !== undefined || a.ir_path !== undefined;
      const project = hasIr ? loadIr(a.ir, a.ir_path) : undefined;
      const voDir = a.out_dir ?? join(a.ir_path ? dirname(dirname(a.ir_path)) : join(workDir(), project?.name ?? "voiceover"), "voiceover");
      const pieces = await speakScript(py(), a.script, voDir, { voice: a.voice, speed: a.speed, lang: a.lang, onProgress: prog });
      const takes = pieces.map((p) => ({ path: p.path, duration_s: Math.round(p.durationSec * 100) / 100 }));
      if (!project) return text({ takes, nextStep: "Pass ir_path (from remove_silence / remove_filler) to place these on the timeline, or import them into the 04 VOICE-OVER bin." });
      const placed = placeVoiceover(project, a.sequence, pieces, { startSec: a.start_s, gapSec: a.gap_s, duckDb: a.duck_db });
      const out = assertProject(placed.project);
      const seqName = a.sequence ?? out.sequences[0]!.name;
      const qc = qcProject(out, seqName);
      const outDir = a.ir_path ? dirname(a.ir_path) : join(workDir(), out.name, "timelines");
      const built = await buildSequence(out, { bridge, outDir, sequence: seqName });
      return text({ takes, track: `A${placed.track + 1}`, placed: placed.placed, ducked_clips: placed.ducked_clips, qc, build: built, ir_path: saveIr(out, built.xmlPath) });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "audio_mix",
  {
    title: "Duck music under speech",
    description: "Lower music (or chosen tracks) whenever speech plays, with smooth ramps, then rebuild the sequence. Tracks are numbered like Premiere: 1 = A1.",
    inputSchema: {
      ir: z.any().optional(),
      ir_path: z.string().optional(),
      sequence: z.string().optional(),
      duck_under: z.array(z.number().int().min(1)).min(1).describe("Speech tracks, e.g. [1, 2]"),
      duck: z.union([z.literal("music"), z.array(z.number().int().min(1))]).default("music"),
      duck_db: z.number().min(-40).max(0).default(-15),
      attack_s: z.number().min(0).max(2).default(0.25),
      release_s: z.number().min(0).max(3).default(0.5),
    },
  },
  async (a) => {
    try {
      const project = loadIr(a.ir, a.ir_path);
      const seq = a.sequence ? project.sequences.find((s) => s.name === a.sequence) : project.sequences[0];
      if (!seq) return fail(`Sequence not in IR: ${a.sequence}`);
      const targets = a.duck === "music" ? musicTracks(project, seq) : a.duck.map((n) => n - 1);
      if (!targets.length) return fail("No music tracks found (music comes from the 03 MUSIC bin). Pass duck: [track numbers].");
      const r = applyDucking(project, seq.name, a.duck_under.map((n) => n - 1), targets, { duckDb: a.duck_db, attackSec: a.attack_s, releaseSec: a.release_s });
      const out = assertProject(r.project);
      const outDir = a.ir_path ? dirname(a.ir_path) : join(workDir(), out.name, "timelines");
      const built = await buildSequence(out, { bridge, outDir, sequence: seq.name });
      return text({ ducked_clips: r.ducked, tracks: targets.map((t) => `A${t + 1}`), build: built, ir_path: saveIr(out, built.xmlPath) });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

await server.connect(new StdioServerTransport());
log("MCP server ready on stdio");

const shutdown = async () => {
  await bridge.stop().catch(() => {});
  mediaIndex?.close();
  worker?.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Client went away (Claude closed): free port 47800 for the next run.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
