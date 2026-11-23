#!/usr/bin/env node
/**
 * Editz daemon: MCP server on stdio for Claude + WebSocket bridge for Premiere panels.
 * stdout belongs to MCP. Log to stderr only.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseProject, PPRO_TICKS_PER_SECOND, secondsToFrames } from "@editz/ir";
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
import { mergeReports, qcProject, qcRender, QC_TARGETS } from "./qc.ts";

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
      return text({ stats, qc, build: built });
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

await server.connect(new StdioServerTransport());
log("MCP server ready on stdio");

const shutdown = async () => {
  await bridge.stop().catch(() => {});
  mediaIndex?.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Client went away (Claude closed): free port 47800 for the next run.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
