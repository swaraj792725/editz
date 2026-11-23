import type { LevelKey, Project, Sequence } from "@editz/ir";

export interface DuckOptions {
  /** How far the ducked tracks dip, dB. PRD: music −12 to −18 under speech. */
  duckDb?: number;
  /** Ramp down before speech starts, seconds. */
  attackSec?: number;
  /** Ramp back up after speech ends, seconds. */
  releaseSec?: number;
  /** Speech gaps shorter than this stay ducked (no pumping between sentences). */
  holdSec?: number;
}

type Span = { start: number; end: number };

/** Pure: where any clip on these tracks plays, in frames, merged across short gaps. */
export function activeSpans(seq: Sequence, tracks: number[], holdFrames = 0): Span[] {
  const spans = tracks
    .flatMap((t) => seq.audio[t]?.items ?? [])
    .filter((c) => c.enabled !== false)
    .map((c) => ({ start: c.start, end: c.end }))
    .sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= holdFrames) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/**
 * Pure: keyframes (frames from clip start) that dip one clip under the spans.
 * Builds a piecewise-linear envelope on the timeline, then samples it inside the clip.
 */
export function duckKeys(clip: Span, spans: Span[], duckDb: number, attack: number, release: number): LevelKey[] | undefined {
  const pts: { t: number; db: number }[] = [];
  for (const s of spans) {
    if (s.end + release < clip.start || s.start - attack > clip.end) continue;
    pts.push({ t: s.start - attack, db: 0 }, { t: s.start, db: duckDb }, { t: s.end, db: duckDb }, { t: s.end + release, db: 0 });
  }
  if (!pts.length) return undefined;
  const env = (t: number) => {
    if (t <= pts[0]!.t || t >= pts[pts.length - 1]!.t) return 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (t <= b.t) return b.t === a.t ? b.db : a.db + ((b.db - a.db) * (t - a.t)) / (b.t - a.t);
    }
    return 0;
  };
  const len = clip.end - clip.start;
  const frames = new Set([0, len, ...pts.map((p) => p.t - clip.start).filter((f) => f > 0 && f < len)]);
  const keys = [...frames].sort((a, b) => a - b).map((f) => ({ frame: Math.round(f), db: Math.round(env(clip.start + f) * 10) / 10 }));
  // Drop keys in the middle of flat stretches.
  const slim = keys.filter((k, i) => i === 0 || i === keys.length - 1 || !(keys[i - 1]!.db === k.db && keys[i + 1]!.db === k.db));
  return slim.every((k) => k.db === 0) ? undefined : slim;
}

/** Tracks holding music (by bin), for "duck the music". */
export function musicTracks(project: Pick<Project, "media">, seq: Sequence): number[] {
  const music = new Set(project.media.filter((m) => /^03 MUSIC/i.test(m.bin)).map((m) => m.id));
  return seq.audio.map((t, i) => (t.items.some((c) => music.has(c.media_id)) ? i : -1)).filter((i) => i >= 0);
}

/** Pure: copy of the project with the target tracks ducked under the trigger tracks. */
export function applyDucking(project: Project, seqName: string | undefined, triggers: number[], targets: number[], o: DuckOptions = {}): { project: Project; ducked: number } {
  const fps = (s: Sequence) => s.rate.num / s.rate.den;
  let ducked = 0;
  const sequences = project.sequences.map((seq, si) => {
    if (seqName ? seq.name !== seqName : si !== 0) return seq;
    const f = (sec: number) => Math.round(sec * fps(seq));
    const spans = activeSpans(seq, triggers, f(o.holdSec ?? 1.2));
    const audio = seq.audio.map((t, ti) => {
      if (!targets.includes(ti) || triggers.includes(ti)) return t;
      return {
        ...t,
        items: t.items.map((c) => {
          const levels = duckKeys(c, spans, o.duckDb ?? -15, f(o.attackSec ?? 0.25), f(o.releaseSec ?? 0.5));
          if (levels) ducked++;
          const { levels: _old, ...rest } = c;
          return levels ? { ...rest, levels } : rest;
        }),
      };
    });
    return { ...seq, audio };
  });
  return { project: { ...project, sequences }, ducked };
}
