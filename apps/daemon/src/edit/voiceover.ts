import type { MediaRef, Project, Sequence } from "@editz/ir";
import { BINS } from "../organize.ts";
import { applyDucking, musicTracks, type DuckOptions } from "./mix.ts";

export interface VoPiece {
  path: string;
  durationSec: number;
  channels?: number;
  /** Place at this time instead of right after the previous piece. */
  atSec?: number;
}

export interface PlaceOptions extends DuckOptions {
  startSec?: number;
  /** Pause between paragraphs, seconds. */
  gapSec?: number;
  /** Duck these audio tracks under the VO. Default: tracks holding music. */
  duck?: number[];
}

/** Split a VO script into paragraphs (blank line or a line per paragraph). */
export function paragraphs(script: string): string[] {
  const blocks = script.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  return blocks.length > 1 ? blocks : script.split("\n").map((p) => p.trim()).filter(Boolean);
}

/** The VO track: one named "VO", else A2 if it is free of other audio, else a new track. */
function voTrack(project: Project, seq: Sequence): { audio: Sequence["audio"]; index: number } {
  const audio = seq.audio.map((t) => ({ ...t, items: [...t.items] }));
  const named = audio.findIndex((t) => /^(vo|voice[- ]?over)$/i.test(t.name ?? ""));
  if (named >= 0) return { audio, index: named };
  const voMedia = new Set(project.media.filter((m) => m.bin.startsWith(BINS.vo)).map((m) => m.id));
  const voOnly = audio.findIndex((t, i) => i > 0 && t.items.length > 0 && t.items.every((c) => voMedia.has(c.media_id)));
  if (voOnly >= 0) return { audio, index: voOnly };
  while (audio.length < 2) audio.push({ name: `A${audio.length + 1}`, items: [] });
  if (audio[1]!.items.length === 0) {
    audio[1]!.name ??= "VO";
    return { audio, index: 1 };
  }
  audio.push({ name: "VO", items: [] });
  return { audio, index: audio.length - 1 };
}

/** Pure: add VO files to a sequence on the VO track, then duck the music under them. */
export function placeVoiceover(project: Project, seqName: string | undefined, pieces: VoPiece[], o: PlaceOptions = {}) {
  const si = seqName ? project.sequences.findIndex((s) => s.name === seqName) : 0;
  const seq = project.sequences[si];
  if (!seq) throw new Error(`Sequence not in IR: ${seqName}`);
  const fps = seq.rate.num / seq.rate.den;
  const f = (sec: number) => Math.round(sec * fps);
  const { audio, index } = voTrack(project, seq);
  const taken = new Set(project.media.map((m) => m.id));
  const clipIds = new Set(project.sequences.flatMap((s) => [...s.video, ...s.audio].flatMap((t) => t.items.map((c) => c.id))));
  const fresh = (base: string, used: Set<string>) => {
    let i = 1;
    while (used.has(`${base}${i}`)) i++;
    used.add(`${base}${i}`);
    return `${base}${i}`;
  };

  const media: MediaRef[] = [];
  const placed: { media_id: string; path: string; start_s: number; end_s: number }[] = [];
  let cursor = f(o.startSec ?? 0);
  for (const p of pieces) {
    const id = fresh("vo", taken);
    const len = Math.max(1, Math.floor(p.durationSec * fps));
    const start = p.atSec !== undefined ? f(p.atSec) : cursor;
    const track = audio[index]!;
    const clash = track.items.find((c) => c.start < start + len && start < c.end);
    if (clash) throw new Error(`VO at ${(start / fps).toFixed(2)} s would overlap ${clash.name ?? clash.id} on the VO track.`);
    media.push({ id, path: p.path, kind: "audio", duration: len, has_video: false, has_audio: true, audio_channels: p.channels ?? 1, bin: BINS.vo });
    track.items.push({ id: fresh("vo-clip-", clipIds), media_id: id, start, end: start + len, in: 0, enabled: true, name: `VO ${placed.length + 1}` });
    track.items.sort((a, b) => a.start - b.start);
    placed.push({ media_id: id, path: p.path, start_s: Math.round((start / fps) * 1000) / 1000, end_s: Math.round(((start + len) / fps) * 1000) / 1000 });
    cursor = start + len + f(o.gapSec ?? 0.4);
  }

  const withVo: Project = {
    ...project,
    bins: project.bins.includes(BINS.vo) ? project.bins : [...project.bins, BINS.vo],
    media: [...project.media, ...media],
    sequences: project.sequences.map((s, i) => (i === si ? { ...seq, audio } : s)),
  };
  const targets = o.duck ?? musicTracks(withVo, withVo.sequences[si]!);
  const { project: out, ducked } = applyDucking(withVo, withVo.sequences[si]!.name, [index], targets, o);
  return { project: out, track: index, placed, ducked_clips: ducked, ducked_tracks: targets };
}
