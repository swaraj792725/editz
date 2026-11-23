import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { assertProject, type Project } from "@editz/ir";
import { keepRanges, silenceCutProject, type CutStats, type KeepOptions } from "../edit/silence-cut.ts";
import { ingest } from "../media/analyze.ts";
import { normalizeVoice, probe, type MediaInfo, type Range } from "../media/ffmpeg.ts";
import type { MediaIndex } from "../media/index-db.ts";
import type { CallOptions } from "../worker.ts";
import { buildCues, toSrt, toVtt, type CaptionOptions, type Cue } from "./captions.ts";
import { findFillers, subtractRanges, tidyWords, wordsOnTimeline, type FillerHit, type FillerOptions, type Transcript, type Word } from "./transcript.ts";
import { paragraphs, type VoPiece } from "../edit/voiceover.ts";

/** What the speech tools need from the Python worker (PyWorker, or a fake in tests). */
export interface WorkerLike {
  call<T = unknown>(method: string, params?: object, o?: CallOptions): Promise<T>;
}

export const DEFAULT_ASR_MODEL = "mlx-community/whisper-large-v3-turbo";

export interface TranscribeOptions {
  model?: string;
  language?: string;
  /** Keep "um"/"uh" in the text (needed to cut them). Default true. */
  verbatim?: boolean;
  onProgress?: CallOptions["onProgress"];
}

export interface TranscriptResult {
  checksum: string;
  path: string;
  info: MediaInfo;
  transcript: Transcript;
  cached: boolean;
  json_path: string;
}

/** Transcribe once per file content + settings; later calls read the Media Index. */
export async function transcribeFile(index: MediaIndex, worker: WorkerLike, path: string, cacheDir: string, o: TranscribeOptions = {}): Promise<TranscriptResult> {
  const m = await ingest(index, path);
  if (!m.info.hasAudio) throw new Error(`No sound in ${basename(path)}, so there is nothing to transcribe.`);
  const model = o.model ?? DEFAULT_ASR_MODEL;
  const verbatim = o.verbatim ?? true;
  const kind = `transcript/v1/${model}/${o.language ?? "auto"}/${verbatim ? "verbatim" : "clean"}`;
  const tag = `${m.checksum}-${model.split("/").pop()}-${o.language ?? "auto"}-${verbatim ? "v" : "c"}`;
  const jsonPath = join(cacheDir, `${tag}.json`);
  let transcript = index.getAnalysis<Transcript>(m.checksum, kind);
  const cached = !!transcript;
  if (!transcript) {
    transcript = await worker.call<Transcript>("transcribe", { path, model, language: o.language, verbatim }, { onProgress: o.onProgress, timeoutMs: Math.max(10 * 60_000, m.info.durationSec * 2000) });
    index.putAnalysis(m.checksum, kind, transcript);
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(transcript));
  return { checksum: m.checksum, path, info: m.info, transcript, cached, json_path: jsonPath };
}

export interface FillerCutOptions extends FillerOptions {
  /** Silent ranges (from analyze); omit to keep pauses. */
  silence?: Range[];
  keep?: KeepOptions;
  sequence?: string;
  captions?: CaptionOptions;
}

export interface FillerCut {
  project: Project;
  stats: CutStats & { fillers_removed: number; filler_s: number };
  fillers: FillerHit[];
  /** Words where they land on the new timeline. */
  words: Word[];
  cues: Cue[];
}

/** Pure: source info + words (+ silences) → tight cut without fillers, and captions timed to it. */
export function fillerCutPlan(info: MediaInfo, words: Word[], o: FillerCutOptions = {}): FillerCut {
  const all = [{ start: 0, end: info.durationSec }];
  const base = o.silence ? keepRanges(o.silence, info.durationSec, o.keep) : all;
  const fillers = findFillers(words, o);
  const keep = subtractRanges(base, fillers);
  if (!keep.length) throw new Error("Nothing left to keep after cutting. Try a lower silence_db or aggressive=false.");
  const { project: input, stats } = silenceCutProject(info, keep, o.sequence);
  const project = assertProject(input);
  const tl = tidyWords(wordsOnTimeline(project, project.sequences[0]!, new Map([["src", words]])));
  const filler_s = Math.round(fillers.reduce((s, f) => s + f.end - f.start, 0) * 100) / 100;
  return { project, stats: { ...stats, fillers_removed: fillers.length, filler_s }, fillers, words: tl, cues: buildCues(tl, o.captions) };
}

/** Write captions next to a timeline. Returns the written paths. */
export function writeCaptions(cues: Cue[], basePath: string, format: "srt" | "vtt" | "both" = "srt"): string[] {
  const out: string[] = [];
  const stem = basePath.replace(/\.(xml|srt|vtt|json)$/i, "");
  if (format !== "vtt") {
    writeFileSync(`${stem}.srt`, toSrt(cues));
    out.push(`${stem}.srt`);
  }
  if (format !== "srt") {
    writeFileSync(`${stem}.vtt`, toVtt(cues));
    out.push(`${stem}.vtt`);
  }
  return out;
}

/** The IR beside its XML, so later tools (captions, VO, mix) can pick the edit up again. */
export function saveIr(project: Project, xmlPath: string): string {
  const p = xmlPath.replace(/\.xml$/i, "") + ".editz.json";
  writeFileSync(p, JSON.stringify(project, null, 2));
  return p;
}

export function loadIr(ir: unknown, irPath?: string): Project {
  const input = ir ?? (irPath ? JSON.parse(readFileSync(irPath, "utf8")) : undefined);
  if (!input) throw new Error("Pass ir or ir_path (the .editz.json saved next to a built timeline).");
  return assertProject(input);
}

// ───────────────────────── voice ─────────────────────────

const VOICE_LANG: Record<string, [string, string]> = {
  a: ["en-us", "American English"],
  b: ["en-gb", "British English"],
  e: ["es", "Spanish"],
  f: ["fr-fr", "French"],
  h: ["hi", "Hindi"],
  i: ["it", "Italian"],
  j: ["ja", "Japanese"],
  p: ["pt-br", "Brazilian Portuguese"],
  z: ["cmn", "Mandarin Chinese"],
};

/** Kokoro voice ids start with language + gender: "af_heart" = American English, female. */
export function langForVoice(voice: string): string {
  return VOICE_LANG[voice[0] ?? "a"]?.[0] ?? "en-us";
}

/** Voices grouped by language and gender: { "British English": { female: [...], male: [...] } }. */
export function describeVoices(ids: string[]): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const id of ids) {
    const lang = VOICE_LANG[id[0] ?? ""]?.[1] ?? "Other";
    const g = id[1] === "m" ? "male" : id[1] === "f" ? "female" : "other";
    ((out[lang] ??= {})[g] ??= []).push(id);
  }
  return out;
}

export interface VoiceOptions {
  voice?: string;
  speed?: number;
  lang?: string;
  onProgress?: CallOptions["onProgress"];
}

/** Script → one loudness-matched 48 kHz WAV per paragraph, in outDir. */
export async function speakScript(worker: WorkerLike, script: string, outDir: string, o: VoiceOptions = {}): Promise<VoPiece[]> {
  const parts = paragraphs(script);
  if (!parts.length) throw new Error("The script is empty.");
  mkdirSync(outDir, { recursive: true });
  const voice = o.voice ?? "af_heart";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const pieces: VoPiece[] = [];
  for (const [i, text] of parts.entries()) {
    const n = String(i + 1).padStart(2, "0");
    const raw = join(outDir, `.vo-${stamp}-${n}.raw.wav`);
    const out = join(outDir, `vo-${stamp}-${n}.wav`);
    o.onProgress?.(`voice ${i + 1}/${parts.length}`, i / parts.length);
    await worker.call("tts", { text, out: raw, voice, speed: o.speed ?? 1, lang: o.lang ?? langForVoice(voice) }, { onProgress: o.onProgress, timeoutMs: 10 * 60_000 });
    await normalizeVoice(raw, out);
    rmSync(raw, { force: true });
    const info = await probe(out);
    pieces.push({ path: out, durationSec: info.durationSec, channels: 1 });
  }
  return pieces;
}

export const stemOf = (p: string) => basename(p, extname(p));
