import { basename, extname } from "node:path";
import type { ProjectInput, Rate } from "@editz/ir";
import type { MediaInfo, Range } from "../media/ffmpeg.ts";

export interface KeepOptions {
  /** Breathing room kept around speech, seconds (handles). */
  padSec?: number;
  /** Pieces shorter than this are dropped (clicks, breaths). */
  minKeepSec?: number;
  /** Gaps shorter than this are not cut (avoids jumpy micro-cuts). */
  mergeGapSec?: number;
}

/** Pure: silent ranges → ranges to keep (speech + padding), merged and cleaned. */
export function keepRanges(silences: Range[], durationSec: number, o: KeepOptions = {}): Range[] {
  const pad = o.padSec ?? 0.15;
  const minKeep = o.minKeepSec ?? 0.4;
  const mergeGap = o.mergeGapSec ?? 0.3;
  const speech: Range[] = [];
  let t = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start > t) speech.push({ start: t, end: Math.min(s.start, durationSec) });
    t = Math.max(t, s.end);
  }
  if (t < durationSec) speech.push({ start: t, end: durationSec });

  const padded = speech.map((r) => ({ start: Math.max(0, r.start - pad), end: Math.min(durationSec, r.end + pad) }));
  const merged: Range[] = [];
  for (const r of padded) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= mergeGap) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.end - r.start >= minKeep).map((r) => ({ start: round3(r.start), end: round3(r.end) }));
}
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface CutStats {
  original_s: number;
  kept_s: number;
  removed_s: number;
  removed_pct: number;
  pieces: number;
}

/** Pure: one source file + keep ranges → an IR project with a tight cut (linked V+A). */
export function silenceCutProject(info: MediaInfo, keep: Range[], name?: string): { project: ProjectInput; stats: CutStats } {
  const rate: Rate = info.rate ?? { num: 30, den: 1 };
  const f = (sec: number) => Math.round((sec * rate.num) / rate.den);
  const mediaFrames = Math.floor((info.durationSec * rate.num) / rate.den);
  const base = basename(info.path, extname(info.path));
  const mediaId = "src";
  const v: ProjectInput["sequences"][number]["video"][number]["items"] = [];
  const a: typeof v = [];
  let cursor = 0;
  keep.forEach((r, i) => {
    const inF = f(r.start);
    const outF = Math.min(f(r.end), mediaFrames);
    const len = outF - inF;
    if (len <= 0) return;
    const clip = { media_id: mediaId, start: cursor, end: cursor + len, in: inF, name: `${base} ${i + 1}` };
    if (info.hasVideo) v.push({ id: `v${i + 1}`, ...clip });
    if (info.hasAudio) a.push({ id: `a${i + 1}`, ...clip });
    cursor += len;
  });
  const keptSec = (cursor * rate.den) / rate.num;
  const seqName = name ?? `${base} - tight`;
  const project: ProjectInput = {
    ir_version: 1,
    name: seqName,
    media: [
      {
        id: mediaId,
        path: info.path,
        kind: info.hasVideo ? "video" : "audio",
        duration: mediaFrames,
        width: info.width,
        height: info.height,
        has_video: info.hasVideo,
        has_audio: info.hasAudio,
        audio_channels: Math.min(Math.max(info.audioChannels ?? 2, 1), 32),
        bin: "01 A-ROLL",
      },
    ],
    sequences: [
      {
        name: seqName,
        rate,
        width: info.width ?? 1920,
        height: info.height ?? 1080,
        video: [{ name: "V1", items: v }],
        audio: info.hasAudio ? [{ name: "A1", items: a }] : [],
      },
    ],
  };
  return {
    project,
    stats: {
      original_s: round3(info.durationSec),
      kept_s: round3(keptSec),
      removed_s: round3(info.durationSec - keptSec),
      removed_pct: info.durationSec ? Math.round((1 - keptSec / info.durationSec) * 100) : 0,
      pieces: Math.max(v.length, a.length),
    },
  };
}
