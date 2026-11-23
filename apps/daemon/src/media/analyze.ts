import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { MEDIA_EXTS } from "../organize.ts";
import { detectScenes, detectSilence, measureLoudness, probe, type Loudness, type MediaInfo, type Range, type RunOptions, type SilenceOptions } from "./ffmpeg.ts";
import type { IndexedMedia, MediaIndex } from "./index-db.ts";

export type AnalysisKind = "silence" | "loudness" | "scenes";

export interface Analysis {
  checksum: string;
  path: string;
  info: MediaInfo;
  /** Silent ranges, seconds. */
  silence?: Range[];
  /** Fraction of the file that is silent (0..1). */
  silentRatio?: number;
  loudness?: Loudness;
  /** Shot cut times, seconds. */
  scenes?: number[];
  /** Which results came from the cache (analyse once). */
  cached: AnalysisKind[];
}

export interface AnalyzeOptions extends SilenceOptions {
  sceneThreshold?: number;
  run?: RunOptions;
}

const INFO_VERSION = "probe/v1";

/** Probe a file once per content checksum. */
export async function ingest(index: MediaIndex, path: string, run?: RunOptions): Promise<IndexedMedia & { cached: boolean }> {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  const checksum = index.checksumFor(path);
  const hit = index.getAnalysis<MediaInfo>(checksum, INFO_VERSION);
  if (hit) return { checksum, path, info: { ...hit, path }, cached: true };
  const info = await probe(path, run);
  index.putInfo(checksum, info);
  index.putAnalysis(checksum, INFO_VERSION, info);
  return { checksum, path, info, cached: false };
}

export async function analyze(index: MediaIndex, path: string, kinds: AnalysisKind[], o: AnalyzeOptions = {}): Promise<Analysis> {
  const m = await ingest(index, path, o.run);
  const out: Analysis = { checksum: m.checksum, path, info: m.info, cached: [] };
  const cachedOr = async <T>(kind: AnalysisKind, key: string, fn: () => Promise<T>): Promise<T> => {
    const hit = index.getAnalysis<T>(m.checksum, key);
    if (hit !== undefined) {
      out.cached.push(kind);
      return hit;
    }
    const v = await fn();
    index.putAnalysis(m.checksum, key, v);
    return v;
  };

  if (kinds.includes("silence") && m.info.hasAudio) {
    const th = o.thresholdDb ?? -35;
    const d = o.minSilenceSec ?? 0.5;
    out.silence = await cachedOr("silence", `silence/v1/${th}dB/${d}s`, () => detectSilence(path, m.info.durationSec, { thresholdDb: th, minSilenceSec: d }, o.run));
    const silent = out.silence.reduce((s, r) => s + (r.end - r.start), 0);
    out.silentRatio = m.info.durationSec ? Number((silent / m.info.durationSec).toFixed(3)) : 0;
  }
  if (kinds.includes("loudness") && m.info.hasAudio) {
    out.loudness = await cachedOr("loudness", "loudness/v1", () => measureLoudness(path, o.run));
  }
  if (kinds.includes("scenes") && m.info.hasVideo && !m.info.isImage) {
    const th = o.sceneThreshold ?? 0.35;
    out.scenes = await cachedOr("scenes", `scenes/v1/${th}`, () => detectScenes(path, th, o.run));
  }
  return out;
}

/** Media files under a folder (same skip rules as organise), or the given file paths. */
export function collectMedia(paths: string[], maxFiles = 2000): string[] {
  const found: string[] = [];
  const walk = (p: string) => {
    if (found.length >= maxFiles) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      if (/\.(app|fcpbundle|prproj)$/i.test(p) || /Auto-Save|Media Cache/i.test(p)) return;
      for (const e of readdirSync(p).sort()) if (!e.startsWith(".")) walk(join(p, e));
    } else if (MEDIA_EXTS.has(extname(p).toLowerCase())) found.push(p);
  };
  for (const p of paths) walk(p);
  return found;
}

/** Compact per-file summary for Claude (no raw ranges, keeps usage low). */
export function summarize(a: Analysis) {
  const i = a.info;
  return {
    path: a.path,
    duration_s: Number(i.durationSec.toFixed(2)),
    video: i.hasVideo ? `${i.width}x${i.height}${i.rate ? ` @ ${(i.rate.num / i.rate.den).toFixed(3)}` : ""}${i.rotation ? ` rot${i.rotation}` : ""}` : null,
    audio: i.hasAudio ? `${i.audioChannels ?? "?"}ch ${i.audioRate ?? "?"}Hz` : null,
    loudness_lufs: a.loudness ? round1(a.loudness.integrated) : undefined,
    true_peak_db: a.loudness ? round1(a.loudness.truePeak) : undefined,
    silent_pct: a.silentRatio !== undefined ? Math.round(a.silentRatio * 100) : undefined,
    shots: a.scenes ? a.scenes.length + 1 : undefined,
  };
}
const round1 = (n: number) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : n);
