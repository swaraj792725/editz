import type { Word } from "./transcript.ts";

/** Defaults follow common broadcast/Netflix style: ≤ 2 lines, ≤ 42 chars a line, ≤ 17 chars a second. */
export interface CaptionOptions {
  maxChars?: number;
  maxLines?: number;
  maxCps?: number;
  /** Shortest time a caption stays up, seconds. */
  minDur?: number;
  maxDur?: number;
  /** A pause this long starts a new caption. */
  pauseSplit?: number;
  /** Gap kept between captions, seconds (~2 frames). */
  gap?: number;
}

export interface Cue {
  start: number;
  end: number;
  lines: string[];
}

export interface CaptionIssue {
  cue: number;
  at: number;
  message: string;
  blocking: boolean;
}

const D = { maxChars: 42, maxLines: 2, maxCps: 17, minDur: 5 / 6, maxDur: 7, pauseSplit: 0.7, gap: 0.08 };
const opt = (o: CaptionOptions) => ({ ...D, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) }) as typeof D;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const join = (ws: Word[]) => ws.map((w) => w.text.trim()).filter(Boolean).join(" ");
const chars = (c: Cue) => c.lines.join(" ").length;

/** Pure: text → lines that fit, balanced, preferring a break after punctuation. null if it can't fit. */
export function splitLines(text: string, maxChars = D.maxChars, maxLines = D.maxLines): string[] | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= maxChars) return [t];
  if (maxLines < 2) return null;
  const ws = t.split(" ");
  let best: { lines: string[]; score: number } | null = null;
  for (let i = 1; i < ws.length; i++) {
    const a = ws.slice(0, i).join(" ");
    const rest = ws.slice(i).join(" ");
    let tail: string[] | null = rest.length <= maxChars ? [rest] : maxLines > 2 ? splitLines(rest, maxChars, maxLines - 1) : null;
    if (a.length > maxChars || !tail) continue;
    // Balanced lines read best; a break after punctuation reads better still.
    const score = Math.abs(a.length - tail[0]!.length) - (/[,.;:!?]$/.test(a) ? 8 : 0);
    if (!best || score < best.score) best = { lines: [a, ...tail], score };
  }
  return best?.lines ?? null;
}

/** Pure: timed words → caption cues. */
export function buildCues(words: Word[], o: CaptionOptions = {}): Cue[] {
  const c = opt(o);
  const cues: Cue[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = join(cur);
    cues.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, lines: splitLines(text, c.maxChars, c.maxLines) ?? [text] });
    cur = [];
  };
  for (const w of words) {
    if (!w.text.trim()) continue;
    if (cur.length) {
      const prev = cur[cur.length - 1]!;
      const sofar = join(cur);
      const breakHere =
        w.start - prev.end > c.pauseSplit ||
        w.end - cur[0]!.start > c.maxDur ||
        !splitLines(join([...cur, w]), c.maxChars, c.maxLines) ||
        (/[.!?]["”']?$/.test(prev.text) && sofar.length >= 12) ||
        (/[,;:]$/.test(prev.text) && sofar.length > c.maxChars);
      if (breakHere) flush();
    }
    cur.push(w);
  }
  flush();

  // Timing: stay up long enough to read, never overlap the next caption.
  for (let i = 0; i < cues.length; i++) {
    const q = cues[i]!;
    const next = cues[i + 1];
    const want = Math.max(q.end, q.start + c.minDur, q.start + chars(q) / c.maxCps);
    const limit = next ? next.start - c.gap : Infinity;
    q.end = Math.max(Math.min(want, limit, q.start + c.maxDur), Math.min(q.end, limit), q.start + 0.1);
    q.start = r3(q.start);
    q.end = r3(q.end);
  }
  return cues;
}

/** Pure: readability and sync checks for QC. */
export function captionIssues(cues: Cue[], o: CaptionOptions = {}): CaptionIssue[] {
  const c = opt(o);
  const out: CaptionIssue[] = [];
  cues.forEach((q, i) => {
    const dur = q.end - q.start;
    if (q.lines.length > c.maxLines) out.push({ cue: i + 1, at: q.start, message: `${q.lines.length} lines (max ${c.maxLines})`, blocking: true });
    for (const l of q.lines) if (l.length > c.maxChars) out.push({ cue: i + 1, at: q.start, message: `line of ${l.length} characters (max ${c.maxChars})`, blocking: true });
    if (cues[i + 1] && cues[i + 1]!.start < q.end) out.push({ cue: i + 1, at: q.start, message: "overlaps the next caption", blocking: true });
    const cps = chars(q) / Math.max(dur, 0.001);
    if (cps > c.maxCps + 0.5) out.push({ cue: i + 1, at: q.start, message: `fast: ${cps.toFixed(1)} characters a second (target ≤ ${c.maxCps})`, blocking: false });
    if (dur < c.minDur - 0.01) out.push({ cue: i + 1, at: q.start, message: `on screen only ${dur.toFixed(2)} s`, blocking: false });
  });
  return out;
}

function stamp(sec: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((q, i) => `${i + 1}\n${stamp(q.start, ",")} --> ${stamp(q.end, ",")}\n${q.lines.join("\n")}\n`).join("\n");
}

export function toVtt(cues: Cue[]): string {
  return "WEBVTT\n\n" + cues.map((q) => `${stamp(q.start, ".")} --> ${stamp(q.end, ".")}\n${q.lines.join("\n")}\n`).join("\n");
}
