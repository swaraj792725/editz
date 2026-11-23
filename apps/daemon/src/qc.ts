import { existsSync } from "node:fs";
import { framesToSeconds, parseProject, sequenceDuration, type Project, type Rate, type Track } from "@editz/ir";
import { measureLoudness, type Loudness, type RunOptions } from "./media/ffmpeg.ts";

/** QC v0 (PRD §13.1): timeline checks on the IR + loudness on a rendered file. */

export interface QcIssue {
  check: "sequence" | "ir" | "offline" | "gap" | "format" | "duration" | "audio" | "loudness" | "true_peak";
  message: string;
  /** Seconds on the timeline, when it points at a place. */
  at?: number;
}

export interface QcTarget {
  width?: number;
  height?: number;
  rate?: Rate;
  minSec?: number;
  maxSec?: number;
  /** Integrated loudness target, LUFS. */
  lufs: number;
  /** Allowed deviation, LU. */
  lufsTolerance: number;
  /** Max true peak, dBTP. */
  truePeakMax: number;
}

export const QC_TARGETS: Record<string, QcTarget> = {
  youtube: { width: 1920, height: 1080, lufs: -14, lufsTolerance: 1, truePeakMax: -1 },
  reels: { width: 1080, height: 1920, maxSec: 90, lufs: -14, lufsTolerance: 1, truePeakMax: -1 },
  shorts: { width: 1080, height: 1920, maxSec: 60, lufs: -14, lufsTolerance: 1, truePeakMax: -1 },
  podcast: { lufs: -16, lufsTolerance: 1, truePeakMax: -1 },
  broadcast: { lufs: -23, lufsTolerance: 1, truePeakMax: -1 },
  any: { lufs: -14, lufsTolerance: 1, truePeakMax: -1 },
};

export interface QcReport {
  pass: boolean;
  blocking: QcIssue[];
  warnings: QcIssue[];
  metrics: { duration_s?: number; clips?: number; loudness?: Loudness };
}

const sec = (frames: number, rate: Rate) => Math.round(framesToSeconds(frames, rate) * 100) / 100;

/** Gaps between 0 and `end` on one track (frames → issues). */
function gaps(track: Track, end: number, rate: Rate, label: string): QcIssue[] {
  const out: QcIssue[] = [];
  let t = 0;
  for (const c of [...track.items].filter((c) => c.enabled !== false).sort((a, b) => a.start - b.start)) {
    if (c.start > t) out.push({ check: "gap", at: sec(t, rate), message: `${label}: ${c.start - t} empty frames (${sec(c.start - t, rate)} s) at ${sec(t, rate)} s` });
    t = Math.max(t, c.end);
  }
  if (t < end) out.push({ check: "gap", at: sec(t, rate), message: `${label}: picture ends at ${sec(t, rate)} s but the sequence runs to ${sec(end, rate)} s` });
  return out;
}

export function qcProject(input: Project | unknown, sequence?: string, target: QcTarget = QC_TARGETS.any!): QcReport {
  const blocking: QcIssue[] = [];
  const warnings: QcIssue[] = [];
  const { project, issues } = parseProject(input);
  if (!project) return { pass: false, blocking: issues.map((i) => ({ check: "ir", message: `${i.path}: ${i.message}` })), warnings, metrics: {} };
  for (const i of issues) blocking.push({ check: "ir", message: `${i.path}: ${i.message}` });

  const seq = sequence ? project.sequences.find((s) => s.name === sequence) : project.sequences[0];
  if (!seq) return { pass: false, blocking: [...blocking, { check: "sequence", message: `No sequence named ${sequence}` }], warnings, metrics: {} };

  const used = new Set([...seq.video, ...seq.audio].flatMap((t) => t.items.map((c) => c.media_id)));
  for (const m of project.media) if (used.has(m.id) && !existsSync(m.path)) blocking.push({ check: "offline", message: `Offline media: ${m.path}` });

  const end = sequenceDuration(seq);
  const durationSec = sec(end, seq.rate);
  // Picture must be continuous: V1 (base layer) may not have holes. Audio-only edits check A1 instead.
  const base = seq.video.find((t) => t.items.length) ?? seq.audio.find((t) => t.items.length);
  if (!base) blocking.push({ check: "sequence", message: "Sequence is empty" });
  else blocking.push(...gaps(base, end, seq.rate, base === seq.video.find((t) => t.items.length) ? "Picture" : "Audio"));
  if (!seq.audio.some((t) => t.items.length)) warnings.push({ check: "audio", message: "No audio on the timeline" });

  if (target.width && target.height && (seq.width !== target.width || seq.height !== target.height)) {
    blocking.push({ check: "format", message: `Frame size ${seq.width}x${seq.height}, deliverable needs ${target.width}x${target.height}` });
  }
  if (target.rate && target.rate.num * seq.rate.den !== seq.rate.num * target.rate.den) {
    blocking.push({ check: "format", message: `Frame rate ${seq.rate.num}/${seq.rate.den}, deliverable needs ${target.rate.num}/${target.rate.den}` });
  }
  if (target.maxSec && durationSec > target.maxSec) blocking.push({ check: "duration", message: `${durationSec} s is longer than the ${target.maxSec} s limit` });
  if (target.minSec && durationSec < target.minSec) blocking.push({ check: "duration", message: `${durationSec} s is shorter than the ${target.minSec} s minimum` });

  const clips = [...seq.video, ...seq.audio].reduce((n, t) => n + t.items.length, 0);
  return { pass: blocking.length === 0, blocking, warnings, metrics: { duration_s: durationSec, clips } };
}

/** Pure: loudness measurement vs target. */
export function loudnessIssues(l: Loudness, t: QcTarget): QcIssue[] {
  const out: QcIssue[] = [];
  if (!Number.isFinite(l.integrated)) return [{ check: "loudness", message: "The render is silent" }];
  const off = l.integrated - t.lufs;
  if (Math.abs(off) > t.lufsTolerance) {
    out.push({ check: "loudness", message: `Loudness ${l.integrated.toFixed(1)} LUFS, target ${t.lufs} ±${t.lufsTolerance} (${off > 0 ? "too loud" : "too quiet"} by ${Math.abs(off).toFixed(1)} LU)` });
  }
  if (l.truePeak > t.truePeakMax) out.push({ check: "true_peak", message: `True peak ${l.truePeak.toFixed(1)} dBTP is above ${t.truePeakMax} dBTP (risk of clipping)` });
  return out;
}

export async function qcRender(path: string, target: QcTarget = QC_TARGETS.any!, run?: RunOptions): Promise<QcReport> {
  if (!existsSync(path)) return { pass: false, blocking: [{ check: "offline", message: `Render not found: ${path}` }], warnings: [], metrics: {} };
  const loudness = await measureLoudness(path, run);
  const blocking = loudnessIssues(loudness, target);
  return { pass: blocking.length === 0, blocking, warnings: [], metrics: { loudness } };
}

export function mergeReports(...rs: QcReport[]): QcReport {
  const blocking = rs.flatMap((r) => r.blocking);
  return { pass: blocking.length === 0, blocking, warnings: rs.flatMap((r) => r.warnings), metrics: Object.assign({}, ...rs.map((r) => r.metrics)) };
}
