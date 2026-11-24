import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { supportDir } from "../paths.ts";
import type { WorkerLike } from "../speech/service.ts";
import { analyze } from "./analyze.ts";
import { extractFrames, type MediaInfo } from "./ffmpeg.ts";
import type { MediaIndex } from "./index-db.ts";
import { lookFit, type LookProfile } from "./look.ts";

/**
 * Eyes: SigLIP 2 frame embeddings (Python worker) → tags, mood, and search.
 * Embeddings live in the Media Index per checksum, so a clip is looked at once.
 */

export const VISION_MODEL = "siglip2-base-patch16-224";
/** google/siglip2-base-patch16-224 calibration: p = sigmoid(exp(4.7245) · cos − 16.7717). */
export const LOGIT_SCALE = Math.exp(4.724453449249268);
export const LOGIT_BIAS = -16.771724700927734;
export const TAG_MIN_FIT = 0.5;
/** Softmax temperature for comparing moods against each other. */
const MOOD_TEMP = 100;

type Vec = Float32Array;
export type FrameVec = { t: number; vec: Vec };

export const dot = (a: Vec, b: Vec) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};
const norm = (v: Vec): Vec => {
  const n = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / n);
};
/** The model's own calibrated probability. Strict: a generic label ("a bird" on an owl) often scores < 5%. */
export const prob = (cos: number) => 1 / (1 + Math.exp(-(LOGIT_SCALE * cos + LOGIT_BIAS)));
/** Usable 0..1 match strength for ranking and tags: SigLIP 2 text↔image cosines live in ~0.02 (unrelated) … 0.18 (spot on). */
export const FIT_FLOOR = 0.04;
export const FIT_FULL = 0.16;
export const fit = (cos: number) => Math.max(0, Math.min(1, (cos - FIT_FLOOR) / (FIT_FULL - FIT_FLOOR)));

export function decodeVecs(b64: string[]): Vec[] {
  return b64.map((s) => {
    const b = Buffer.from(s, "base64");
    const copy = new Uint8Array(b.byteLength);
    copy.set(b);
    return new Float32Array(copy.buffer);
  });
}

// ───────────────────────── what to look at ─────────────────────────

/**
 * Pure: frame times for a clip. One frame in the middle of every shot, then evenly spaced
 * frames every `every` seconds in between; capped at `max` by keeping an even spread.
 */
export function frameTimes(durationSec: number, scenes: number[] = [], every = 2, max = 24): number[] {
  if (durationSec <= 0) return [0];
  const edge = Math.min(0.1, durationSec / 4);
  const bounds = [0, ...scenes.filter((s) => s > 0 && s < durationSec), durationSec];
  const mids = bounds.slice(1).map((b, i) => (bounds[i]! + b) / 2);
  const grid = Array.from({ length: Math.max(1, Math.floor(durationSec / every)) }, (_, i) => (i + 0.5) * every).filter((t) => t < durationSec);
  const all = [...mids];
  for (const t of grid) if (all.every((m) => Math.abs(m - t) >= every / 2)) all.push(t);
  let times = all.map((t) => Math.min(durationSec - edge, Math.max(edge, t))).sort((a, b) => a - b);
  if (times.length > max) {
    const keep = Array.from({ length: max }, (_, i) => times[Math.round((i * (times.length - 1)) / Math.max(1, max - 1))]!);
    times = [...new Set(keep)];
  }
  return times.map((t) => Math.round(t * 100) / 100);
}

// ───────────────────────── vocabulary ─────────────────────────

/** Zero-shot tag vocabulary. Prompt: "This is a photo of {tag}." */
export const TAGS: Record<string, string[]> = {
  subject: [
    "a person", "a group of people", "a person talking to the camera", "hands", "a face in close-up", "food", "a cup of coffee", "latte art", "a barista making coffee", "an espresso machine", "a drink",
    "a car", "a bicycle", "a dog", "a cat", "a bird", "a building", "a computer", "a phone", "text on screen", "a product on a table",
    "plants", "flowers", "trees", "water", "the sky", "clouds", "mountains", "the sea", "a city skyline", "a street", "a road",
  ],
  setting: [
    "a café", "a kitchen", "a restaurant", "a bar", "an office", "a living room", "a bedroom", "a studio", "a shop", "a classroom",
    "a gym", "a beach", "a forest", "a park", "a city", "the countryside", "a desert", "snow",
  ],
  shot: ["a close-up shot", "a wide shot", "an aerial drone shot", "a shot through a window"],
  light: ["daylight", "night time", "golden hour sunlight", "neon lights", "candlelight", "rain", "fog"],
};

export const MOODS = [
  "cozy", "warm", "calm", "cheerful", "energetic", "dramatic", "moody", "melancholic",
  "romantic", "mysterious", "tense", "playful", "luxurious", "nostalgic", "epic", "minimal",
] as const;

const tagPrompt = (t: string) => `This is a photo of ${t}.`;
const moodPrompts = (m: string) => [`This is a photo with a ${m} mood.`, `a ${m} scene.`];
const queryPrompt = (q: string) => (/^(this is |a photo|an image)/i.test(q) ? q : `This is a photo of ${q}.`);

/** Text embeddings, cached in the Media Index per model + exact text. */
export async function textVectors(index: MediaIndex, worker: WorkerLike, texts: string[]): Promise<Vec[]> {
  const missing = [...new Set(texts.filter((t) => !index.textVector(VISION_MODEL, t)))];
  if (missing.length) {
    const r = await worker.call<{ vectors: string[] }>("embed_texts", { texts: missing }, { timeoutMs: 10 * 60_000 });
    decodeVecs(r.vectors).forEach((v, i) => index.putTextVector(VISION_MODEL, missing[i]!, v));
  }
  return texts.map((t) => index.textVector(VISION_MODEL, t)!);
}

/** One vector per mood: the normalised mean of its prompt wordings. */
async function moodVectors(index: MediaIndex, worker: WorkerLike, moods: readonly string[]): Promise<Vec[]> {
  const prompts = moods.flatMap(moodPrompts);
  const v = await textVectors(index, worker, prompts);
  return moods.map((_, i) => meanVec(v.slice(i * 2, i * 2 + 2)));
}

/** Normalised mean of unit vectors. */
export function meanVec(vs: Vec[]): Vec {
  const out = new Float32Array(vs[0]!.length);
  for (const v of vs) for (let j = 0; j < out.length; j++) out[j]! += v[j]!;
  return norm(out);
}

// ───────────────────────── per-clip reading ─────────────────────────

/** Pure: tag strength (best frame per tag), keeping those ≥ minFit. */
export function clipTags(frames: FrameVec[], tags: { tag: string; group: string; vec: Vec }[], minFit = TAG_MIN_FIT, maxTags = 8) {
  const out = tags.map(({ tag, group, vec }) => {
    let best = -1, at = 0;
    for (const f of frames) {
      const c = dot(f.vec, vec);
      if (c > best) (best = c), (at = f.t);
    }
    return { tag: tag.replace(/^(a|an|the) /, ""), group, fit: round2(fit(best)), at_s: at };
  });
  return out.filter((t) => t.fit >= minFit).sort((a, b) => b.fit - a.fit).slice(0, maxTags);
}

/** Pure: each mood's share of the clip (softmax across moods per frame, averaged over frames). */
export function moodShares(frames: FrameVec[], moodVecs: Vec[]): number[] {
  const acc = new Array(moodVecs.length).fill(0);
  for (const f of frames) {
    const logits = moodVecs.map((m) => MOOD_TEMP * dot(f.vec, m));
    const top = Math.max(...logits);
    const e = logits.map((l) => Math.exp(l - top));
    const z = e.reduce((a, b) => a + b, 0);
    e.forEach((v, i) => (acc[i] += v / z));
  }
  return acc.map((v) => v / Math.max(1, frames.length));
}

/** Pure: top moods, as fit relative to the clip's strongest mood (1 = dominant). */
export function topMoods(shares: number[], names: readonly string[], n = 3) {
  const max = Math.max(...shares, 1e-9);
  return shares
    .map((s, i) => ({ mood: names[i]!, fit: Math.round((s / max) * 100) / 100 }))
    .sort((a, b) => b.fit - a.fit)
    .slice(0, n);
}

export interface VisualResult {
  checksum: string;
  path: string;
  info: MediaInfo;
  frames: number;
  look?: LookProfile;
  cached: boolean;
  skipped?: string;
}

export interface VisualOptions {
  every?: number;
  maxFrames?: number;
  force?: boolean;
  onProgress?: (message: string, value: number | null) => void;
}

export const framesDir = (checksum: string) => join(supportDir(), "cache", "frames", checksum);
export const framePath = (checksum: string, t: number) => join(framesDir(checksum), `${t.toFixed(2)}.jpg`);

/** Look at a file once: shots + look profile (FFmpeg), frame embeddings (worker). */
export async function visualAnalyze(index: MediaIndex, worker: WorkerLike, path: string, o: VisualOptions = {}): Promise<VisualResult> {
  const a = await analyze(index, path, ["scenes", "look"]);
  const base = { checksum: a.checksum, path, info: a.info, look: a.look };
  if (!a.info.hasVideo) return { ...base, frames: 0, cached: false, skipped: "no picture (audio only)" };
  const key = `vision/v1/${VISION_MODEL}/${o.every ?? 2}/${o.maxFrames ?? 24}`;
  const done = index.getAnalysis<{ times: number[] }>(a.checksum, key);
  if (done && !o.force) return { ...base, frames: done.times.length, cached: true };

  const times = a.info.isImage ? [0] : frameTimes(a.info.durationSec, a.scenes, o.every ?? 2, o.maxFrames ?? 24);
  mkdirSync(framesDir(a.checksum), { recursive: true });
  const outs = times.map((t) => framePath(a.checksum, t));
  const need = times.map((t, i) => ({ t, out: outs[i]! })).filter((f) => !existsSync(f.out));
  if (need.length) await extractFrames(path, need.map((f) => f.t), need.map((f) => f.out), 224, !!a.info.isImage);
  const r = await worker.call<{ vectors: string[]; model: string }>("embed_images", { paths: outs }, { onProgress: o.onProgress, timeoutMs: 10 * 60_000 + times.length * 5000 });
  const vecs = decodeVecs(r.vectors);
  index.putFrameVectors(a.checksum, VISION_MODEL, times.map((t, i) => ({ t, vec: vecs[i]! })));
  index.putAnalysis(a.checksum, key, { times });
  return { ...base, frames: times.length, cached: false };
}

/** Tags + moods + look for one analysed file. */
export async function describeVisual(index: MediaIndex, worker: WorkerLike, checksum: string) {
  const frames = index.frameVectors(VISION_MODEL, checksum).get(checksum) ?? [];
  if (!frames.length) return undefined;
  const flat = Object.entries(TAGS).flatMap(([group, ts]) => ts.map((tag) => ({ tag, group })));
  const tv = await textVectors(index, worker, flat.map((t) => tagPrompt(t.tag)));
  const mv = await moodVectors(index, worker, MOODS);
  return {
    tags: clipTags(frames, flat.map((t, i) => ({ ...t, vec: tv[i]! }))),
    moods: topMoods(moodShares(frames, mv), MOODS),
  };
}

// ───────────────────────── search ─────────────────────────

export interface SearchQuery {
  /** What should be in the shot: "barista pouring latte art". */
  query?: string;
  /** Feeling: "cozy", "tense"… (any word; the built-in list is just a start). */
  mood?: string;
  /** Look: "warm", "dark", "moody blue", "#1e3a5f". */
  look?: string;
  /** Path of a clip to look like (visual + colour). */
  like?: string;
  /** Only these checksums (a folder or file list), else everything analysed. */
  within?: Set<string>;
  kind?: "video" | "image" | "any";
  minDurationSec?: number;
  limit?: number;
}

export interface SearchHit {
  path: string;
  checksum: string;
  score: number;
  /** Best moment for the query, seconds. */
  at_s: number;
  frame?: string;
  why: { content?: number; mood?: number; look?: number; like?: number };
  /** The model's calibrated chance the query is in the shot (strict; only for query searches). */
  confidence?: number;
  duration_s: number;
  look_words?: string[];
}

const WEIGHTS = { content: 0.5, mood: 0.25, look: 0.15, like: 0.1 };

export async function searchMedia(index: MediaIndex, worker: WorkerLike, q: SearchQuery): Promise<{ hits: SearchHit[]; searched: number }> {
  if (!q.query && !q.mood && !q.look && !q.like) throw new Error("Give at least one of query, mood, look or like.");
  const all = index.frameVectors(VISION_MODEL);
  const looks = new Map(index.analysesLike<LookProfile>("look/v1/").map((r) => [r.checksum, r.result]));
  const qv = q.query ? (await textVectors(index, worker, [queryPrompt(q.query)]))[0] : undefined;

  let moodNames: string[] = [];
  let moodVecs: Vec[] = [];
  let moodIdx = -1;
  if (q.mood) {
    const m = q.mood.toLowerCase().trim();
    moodNames = [...MOODS.filter((x) => x !== m), m];
    moodVecs = await moodVectors(index, worker, moodNames);
    moodIdx = moodNames.length - 1;
  }

  let likeVec: Vec | undefined;
  let likeLook: LookProfile | undefined;
  if (q.like) {
    const ref = await visualAnalyze(index, worker, q.like);
    const fr = all.get(ref.checksum) ?? index.frameVectors(VISION_MODEL, ref.checksum).get(ref.checksum) ?? [];
    if (fr.length) likeVec = norm(fr[0]!.vec.map((_, j) => fr.reduce((s, f) => s + f.vec[j]!, 0) / fr.length));
    likeLook = ref.look;
  }

  const hits: SearchHit[] = [];
  let searched = 0;
  for (const [checksum, frames] of all) {
    if (q.within && !q.within.has(checksum)) continue;
    const info = index.getInfo(checksum);
    if (!info) continue;
    if (q.kind === "video" && info.isImage) continue;
    if (q.kind === "image" && !info.isImage) continue;
    // A length ask means footage: stills have no length of their own.
    if (q.minDurationSec && (info.isImage || info.durationSec < q.minDurationSec)) continue;
    const path = index.pathsFor(checksum).find((p) => existsSync(p));
    if (!path) continue;
    searched++;

    const why: SearchHit["why"] = {};
    let at = frames[0]!.t;
    let confidence: number | undefined;
    if (qv) {
      let best = -1;
      for (const f of frames) {
        const c = dot(f.vec, qv);
        if (c > best) (best = c), (at = f.t);
      }
      why.content = round2(fit(best));
      confidence = round2(prob(best));
    }
    if (moodIdx >= 0) {
      const shares = moodShares(frames, moodVecs);
      why.mood = round2(shares[moodIdx]! / Math.max(...shares, 1e-9));
    }
    const lp = looks.get(checksum);
    if (q.look && lp) {
      const f = lookFit(lp, q.look);
      if (f !== undefined) why.look = round2(f);
    }
    if (likeVec) {
      const mean = norm(frames[0]!.vec.map((_, j) => frames.reduce((s, f) => s + f.vec[j]!, 0) / frames.length));
      const vis = Math.max(0, Math.min(1, (dot(mean, likeVec) - 0.4) / 0.6));
      const col = lp && likeLook ? (lookFit(lp, likeLook) ?? vis) : vis;
      why.like = round2(0.6 * vis + 0.4 * col);
    }
    let wsum = 0, s = 0;
    for (const [k, v] of Object.entries(why) as [keyof typeof WEIGHTS, number][]) {
      s += WEIGHTS[k] * v;
      wsum += WEIGHTS[k];
    }
    const fp = framePath(checksum, at);
    hits.push({
      path,
      checksum,
      score: round2(wsum ? s / wsum : 0),
      at_s: at,
      frame: existsSync(fp) ? fp : undefined,
      why,
      ...(confidence !== undefined ? { confidence } : {}),
      duration_s: round2(info.durationSec),
      look_words: lp?.labels,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, q.limit ?? 10), searched };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
