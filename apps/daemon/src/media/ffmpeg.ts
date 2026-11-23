import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Rate } from "@editz/ir";
import { supportDir } from "../paths.ts";

/**
 * Thin FFmpeg layer. Everything heavy (analysis, contact sheets, QC) goes through here,
 * so the governor rules (background QoS, timeouts) live in one place.
 */

export class ToolMissingError extends Error {}

const isExec = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** env override → bundled copy in the support dir → PATH. */
export function findTool(name: "ffmpeg" | "ffprobe"): string {
  const env = process.env[`EDITZ_${name.toUpperCase()}`];
  if (env && isExec(env)) return env;
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const bundled = join(supportDir(), "bin", exe);
  if (isExec(bundled)) return bundled;
  const extra = process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
  for (const dir of [...(process.env.PATH ?? "").split(delimiter), ...extra]) {
    if (dir && isExec(join(dir, exe))) return join(dir, exe);
  }
  throw new ToolMissingError(`${name} not found. Editz needs the free tool FFmpeg (it ships with the Editz installer; for now: brew install ffmpeg).`);
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Low priority: efficiency cores + background I/O on macOS, so Premiere stays smooth. */
  background?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const TASKPOLICY = "/usr/sbin/taskpolicy";

export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const bg = opts.background !== false && process.platform === "darwin" && existsSync(TASKPOLICY);
  const [cmd, argv] = bg ? [TASKPOLICY, ["-b", bin, ...args]] : [bin, args];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"], signal: opts.signal });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

async function ffmpeg(args: string[], opts?: RunOptions): Promise<RunResult> {
  const r = await run(findTool("ffmpeg"), ["-hide_banner", "-nostdin", ...args], { timeoutMs: 30 * 60_000, ...opts });
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${tail(r.stderr)}`);
  return r;
}

const tail = (s: string, n = 400) => s.trim().slice(-n);

// ───────────────────────── probe ─────────────────────────

export interface MediaInfo {
  path: string;
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Still image (single frame, no duration). */
  isImage: boolean;
  width?: number;
  height?: number;
  rate?: Rate;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  audioRate?: number;
  /** Display rotation in degrees (phone footage). Width/height are already swapped for 90/270. */
  rotation?: number;
  formatName?: string;
  bitRate?: number;
}

const IMAGE_CODECS = new Set(["png", "mjpeg", "jpeg2000", "bmp", "tiff", "webp", "gif", "heic", "hevc_image"]);

/** Turn "30000/1001" into a clean rate, snapping near-standard values (29.97 written as 2997/100 etc.). */
export function parseRate(s: string | undefined): Rate | undefined {
  if (!s) return undefined;
  const [n, d] = s.split("/").map(Number);
  if (!n || !d) return undefined;
  const f = n / d;
  for (const [num, den] of [
    [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [48, 1], [50, 1], [60000, 1001], [60, 1], [120, 1],
  ] as const) {
    if (Math.abs(f - num / den) < 0.005) return { num, den };
  }
  const g = gcd(n, d);
  return { num: n / g, den: d / g };
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Pure: ffprobe JSON → MediaInfo. */
export function parseProbe(path: string, json: any): MediaInfo {
  const streams: any[] = json?.streams ?? [];
  const fmt = json?.format ?? {};
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const fmtName = String(fmt.format_name ?? "");
  const isImage = !!v && (fmtName.includes("image2") || fmtName.endsWith("_pipe") || (IMAGE_CODECS.has(v.codec_name) && !a && !Number(fmt.duration)));
  const durationSec = Number(fmt.duration ?? v?.duration ?? a?.duration ?? 0) || 0;
  let rotation = 0;
  for (const sd of v?.side_data_list ?? []) if (typeof sd.rotation === "number") rotation = sd.rotation;
  if (v?.tags?.rotate) rotation = Number(v.tags.rotate);
  rotation = ((Math.round(rotation) % 360) + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  const info: MediaInfo = {
    path,
    durationSec: isImage ? 0 : durationSec,
    hasVideo: !!v,
    hasAudio: !!a,
    isImage,
    formatName: fmtName || undefined,
    bitRate: fmt.bit_rate ? Number(fmt.bit_rate) : undefined,
  };
  if (v) {
    info.width = swap ? v.height : v.width;
    info.height = swap ? v.width : v.height;
    info.videoCodec = v.codec_name;
    if (!isImage) info.rate = parseRate(v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate);
    if (rotation) info.rotation = rotation;
  }
  if (a) {
    info.audioCodec = a.codec_name;
    info.audioChannels = a.channels;
    info.audioRate = a.sample_rate ? Number(a.sample_rate) : undefined;
  }
  return info;
}

export async function probe(path: string, opts?: RunOptions): Promise<MediaInfo> {
  const r = await run(findTool("ffprobe"), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], {
    timeoutMs: 60_000,
    ...opts,
  });
  if (r.code !== 0) throw new Error(`Could not read ${path}: ${tail(r.stderr)}`);
  return parseProbe(path, JSON.parse(r.stdout));
}

// ───────────────────────── silence ─────────────────────────

export interface Range {
  start: number;
  end: number;
}

/** Pure: silencedetect stderr → silent ranges (seconds). A trailing open silence ends at `duration`. */
export function parseSilence(stderr: string, duration: number): Range[] {
  const out: Range[] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) {
      open = Math.max(0, Number(s[1]));
      continue;
    }
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && open !== null) {
      out.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  if (open !== null && duration > open) out.push({ start: open, end: duration });
  return out;
}

export interface SilenceOptions {
  /** dBFS below which audio counts as silence. */
  thresholdDb?: number;
  /** Minimum silence length, seconds. */
  minSilenceSec?: number;
}

export async function detectSilence(path: string, durationSec: number, o: SilenceOptions = {}, opts?: RunOptions): Promise<Range[]> {
  const th = o.thresholdDb ?? -35;
  const d = o.minSilenceSec ?? 0.5;
  const r = await ffmpeg(["-i", path, "-vn", "-sn", "-dn", "-af", `silencedetect=noise=${th}dB:d=${d}`, "-f", "null", "-"], opts);
  return parseSilence(r.stderr, durationSec);
}

// ───────────────────────── loudness ─────────────────────────

export interface Loudness {
  /** Integrated loudness, LUFS. */
  integrated: number;
  /** True peak, dBTP. */
  truePeak: number;
  /** Loudness range, LU. */
  lra: number;
  threshold: number;
}

/** Pure: last JSON block printed by loudnorm=print_format=json. */
export function parseLoudnorm(stderr: string): Loudness {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm printed no measurement");
  const j = JSON.parse(stderr.slice(start, end + 1));
  const num = (v: string) => (v === "-inf" ? -Infinity : Number(v));
  return { integrated: num(j.input_i), truePeak: num(j.input_tp), lra: num(j.input_lra), threshold: num(j.input_thresh) };
}

export async function measureLoudness(path: string, opts?: RunOptions): Promise<Loudness> {
  const r = await ffmpeg(["-i", path, "-vn", "-sn", "-dn", "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"], opts);
  return parseLoudnorm(r.stderr);
}

// ───────────────────────── scene cuts ─────────────────────────

/** Pure: showinfo stderr → cut times (seconds), ascending, de-duplicated. */
export function parseScenes(stderr: string): number[] {
  const t: number[] = [];
  for (const m of stderr.matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*([\d.]+)/g)) t.push(Number(m[1]));
  return [...new Set(t)].sort((a, b) => a - b);
}

/**
 * Shot boundaries, frame-accurate. Every frame is decoded (keyframe-only decoding misses cuts by up to a GOP),
 * but scored at 320 px wide, and decoded on the Mac's media engine when available so the CPU/GPU stay free.
 */
export async function detectScenes(path: string, threshold = 0.35, opts?: RunOptions): Promise<number[]> {
  const tail = ["-i", path, "-an", "-sn", "-dn", "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"];
  const r =
    process.platform === "darwin"
      ? await ffmpeg(["-hwaccel", "videotoolbox", ...tail], opts).catch(() => ffmpeg(tail, opts))
      : await ffmpeg(tail, opts);
  return parseScenes(r.stderr);
}

// ───────────────────────── contact sheets ─────────────────────────

/** Evenly spaced sample times, avoiding the very first/last frame (often black). */
export function sampleTimes(durationSec: number, count: number): number[] {
  if (durationSec <= 0) return [0];
  const n = Math.max(1, Math.floor(count));
  return Array.from({ length: n }, (_, i) => Number((((i + 0.5) / n) * durationSec).toFixed(3)));
}

export interface SheetOptions {
  count?: number;
  cols?: number;
  /** Width of each tile, px. */
  tileWidth?: number;
  /** Explicit sample times (seconds); overrides count. */
  times?: number[];
}

/**
 * One JPEG grid of frames, small enough for Claude to look at cheaply (PRD: ≤ 24 frames per review).
 * Seeks per frame (fast on long files), then tiles.
 */
export async function contactSheet(path: string, durationSec: number, outJpg: string, o: SheetOptions = {}, opts?: RunOptions) {
  const times = (o.times ?? sampleTimes(durationSec, o.count ?? 12)).slice(0, 24);
  const cols = Math.min(o.cols ?? 4, times.length);
  const rows = Math.ceil(times.length / cols);
  const w = o.tileWidth ?? 320;
  const inputs = times.flatMap((t) => ["-ss", String(t), "-i", path]);
  const scaled = times.map((_, i) => `[${i}:v:0]scale=${w}:-2,setsar=1,trim=end_frame=1[f${i}]`).join(";");
  const filter = `${scaled};${times.map((_, i) => `[f${i}]`).join("")}xstack=inputs=${times.length}:layout=${layout(times.length, cols, w)}:fill=black[out]`;
  const args =
    times.length === 1
      ? ["-ss", String(times[0]), "-i", path, "-frames:v", "1", "-vf", `scale=${w}:-2`, "-q:v", "4", "-y", outJpg]
      : [...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-q:v", "4", "-y", outJpg];
  await ffmpeg(args, opts);
  return { path: outJpg, times, cols, rows };
}

/** xstack layout string for a cols-wide grid of equal-width tiles (heights taken from the first tile). */
function layout(n: number, cols: number, w: number): string {
  return Array.from({ length: n }, (_, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = c === 0 ? "0" : String(c * w);
    const y = r === 0 ? "0" : Array.from({ length: r }, () => "h0").join("+");
    return `${x}_${y}`;
  }).join("|");
}
