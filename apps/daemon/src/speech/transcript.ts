import type { Project, Sequence } from "@editz/ir";
import type { Range } from "../media/ffmpeg.ts";

/** Seconds in the source file (or on the timeline, after mapping). */
export interface Word {
  text: string;
  start: number;
  end: number;
  /** Whisper's confidence, 0..1. */
  p?: number;
}

export interface Transcript {
  language: string | null;
  model: string;
  text: string;
  segments: { start: number; end: number; text: string }[];
  words: Word[];
}

/** Lowercase, letters/digits/apostrophes only: "Um," → "um". */
export const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, "");

const FILLERS = new Set(["um", "umm", "ummm", "uh", "uhh", "uhm", "erm", "er", "err", "ah", "ahh", "hmm", "hm", "mm", "mmm", "mhm"]);
/** Only cut when set off by commas ("so, like, we…"); otherwise they carry meaning. */
const SOFT = new Set(["like", "basically", "actually", "literally", "so", "right", "okay"]);
const SOFT_PHRASES = [
  ["you", "know"],
  ["i", "mean"],
  ["kind", "of"],
  ["sort", "of"],
];
/** Doubled words that are often correct English ("had had", "that that"). */
const OK_DOUBLES = new Set(["had", "that", "very", "bye", "no", "yes", "really", "so", "ha", "knock"]);

export interface FillerHit {
  start: number;
  end: number;
  text: string;
  kind: "filler" | "repeat" | "soft";
}

export interface FillerOptions {
  /** Also cut comma-wrapped "like", "you know", "I mean"… Default false. */
  aggressive?: boolean;
  /** Extra single words to treat as fillers. */
  extra?: string[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Pure: words → time ranges to cut (fillers, stutters, and optionally comma-wrapped soft fillers). */
export function findFillers(words: Word[], o: FillerOptions = {}): FillerHit[] {
  const fillers = new Set([...FILLERS, ...(o.extra ?? []).map(norm)]);
  const hits: FillerHit[] = [];
  const cut = (i: number, j: number, kind: FillerHit["kind"]) => {
    const first = words[i]!;
    const last = words[j]!;
    const prev = words[i - 1];
    const next = words[j + 1];
    // Whisper timings drift ±0.1 s: cut from the filler to just before the next word, never into neighbours.
    const start = Math.max(prev ? prev.end : 0, first.start - 0.03);
    const end = next ? Math.max(last.end, next.start - 0.05) : last.end + 0.05;
    if (end > start) hits.push({ start: r3(start), end: r3(end), text: words.slice(i, j + 1).map((w) => w.text).join(" "), kind });
  };
  const commaBefore = (i: number) => i === 0 || /[,.;:!?—–-]$/.test(words[i - 1]!.text);
  const commaAfter = (j: number) => j === words.length - 1 || /[,.;:!?—–-]$/.test(words[j]!.text);

  for (let i = 0; i < words.length; i++) {
    const w = norm(words[i]!.text);
    if (!w) continue;
    if (fillers.has(w)) {
      cut(i, i, "filler");
      continue;
    }
    const nx = words[i + 1];
    if (nx && norm(nx.text) === w && !OK_DOUBLES.has(w) && nx.start - words[i]!.end < 0.6 && !/[.!?]$/.test(words[i]!.text)) {
      cut(i, i, "repeat"); // "we we start" → keep the second "we"
      continue;
    }
    if (o.aggressive) {
      const phrase = SOFT_PHRASES.find((p) => p.every((x, k) => norm(words[i + k]?.text ?? "") === x));
      if (phrase && commaBefore(i) && commaAfter(i + phrase.length - 1)) {
        cut(i, i + phrase.length - 1, "soft");
        i += phrase.length - 1;
      } else if (SOFT.has(w) && commaBefore(i) && commaAfter(i)) cut(i, i, "soft");
    }
  }
  return hits;
}

/** Pure: sorted, merged copy. */
export function mergeRanges(rs: Range[], gap = 0): Range[] {
  const out: Range[] = [];
  for (const r of [...rs].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start - last.end <= gap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Pure: keep − cuts. Pieces shorter than minKeep are dropped. */
export function subtractRanges(keep: Range[], cuts: Range[], minKeep = 0.15): Range[] {
  const cs = mergeRanges(cuts);
  const out: Range[] = [];
  for (const k of mergeRanges(keep)) {
    let pieces: Range[] = [{ ...k }];
    for (const c of cs) {
      if (c.end <= k.start || c.start >= k.end) continue;
      pieces = pieces.flatMap((p) => {
        if (c.end <= p.start || c.start >= p.end) return [p];
        const res: Range[] = [];
        if (c.start > p.start) res.push({ start: p.start, end: c.start });
        if (c.end < p.end) res.push({ start: c.end, end: p.end });
        return res;
      });
    }
    out.push(...pieces);
  }
  return out.filter((r) => r.end - r.start >= minKeep).map((r) => ({ start: r3(r.start), end: r3(r.end) }));
}

/**
 * Pure: where each word lands on the timeline. Walks the clips of one audio track and
 * maps source-time words of each clip's media to record time. Words cut out by the edit
 * disappear; a word half cut is clamped to its clip.
 */
export function wordsOnTimeline(project: Pick<Project, "media">, seq: Sequence, transcripts: Map<string, Word[]>, track?: number): Word[] {
  const fps = seq.rate.num / seq.rate.den;
  const ti = track ?? seq.audio.findIndex((t) => t.items.some((c) => transcripts.has(c.media_id)));
  const items = ti >= 0 ? (seq.audio[ti]?.items ?? []) : [];
  const out: Word[] = [];
  for (const c of items) {
    const words = transcripts.get(c.media_id);
    if (!words || c.enabled === false) continue;
    const srcIn = c.in / fps;
    const srcOut = (c.in + c.end - c.start) / fps;
    const rec = c.start / fps;
    for (const w of words) {
      const mid = (w.start + w.end) / 2;
      if (mid < srcIn || mid >= srcOut) continue;
      out.push({
        ...w,
        start: r3(rec + Math.max(w.start, srcIn) - srcIn),
        end: r3(rec + Math.min(w.end, srcOut) - srcIn),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Pure: after cuts, a word that now opens a sentence gets a capital ("Um, so today" → "So today"). */
export function tidyWords(words: Word[]): Word[] {
  return words.map((w, i) => {
    const prev = words[i - 1];
    const opens = !prev || /[.!?]["”']?$/.test(prev.text.trim());
    const t = w.text.trimStart();
    return opens && /^\p{Ll}/u.test(t) ? { ...w, text: t[0]!.toUpperCase() + t.slice(1) } : w;
  });
}
