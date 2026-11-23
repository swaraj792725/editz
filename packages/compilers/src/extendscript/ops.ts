import { normalizePath, ticksToFrames, type Project, type Rate, type SequenceSnapshot } from "@editz/ir";

/**
 * Typed op protocol shared by the CEP (ExtendScript) and UXP bridges.
 * The daemon sends one op at a time; the host returns { ok, result | error }.
 */

export interface ImportedItem {
  nodeId: string;
  parentNodeId: string | null;
  name: string;
  kind: "clip" | "bin" | "sequence" | "file" | "other";
  mediaPath: string | null;
}

export interface RawTrackItem {
  name: string;
  mediaPath: string;
  start: string; // ticks
  end: string;
  inPoint: string;
}

export interface RawSequence {
  name: string;
  video: RawTrackItem[][];
  audio: RawTrackItem[][];
  markers: { start: string; name: string }[];
}

export type Op =
  | { op: "info"; args: Record<string, never> }
  | { op: "ensureBins"; args: { paths: string[] } }
  | { op: "importFiles"; args: { paths: string[]; bin: string } }
  | { op: "importXml"; args: { path: string } }
  | { op: "moveItems"; args: { moves: { nodeId: string; bin: string }[] } }
  | { op: "deleteBins"; args: { nodeIds: string[] } }
  | { op: "listSequences"; args: Record<string, never> }
  | { op: "readSequence"; args: { name: string } }
  | { op: "addMarkers"; args: { sequence: string; markers: { seconds: number; name: string; comment: string; durationSeconds: number }[] } }
  | { op: "exportSequence"; args: { sequence: string; outPath: string; presetPath: string } };

export type OpName = Op["op"];

export interface HostInfo {
  appVersion: string;
  projectPath: string | null;
  projectName: string | null;
  hasQE: boolean;
  hasEncoder: boolean;
  backend: "cep" | "uxp";
}

/** Bin paths the project needs, including parents ("02 B-ROLL/Own" → "02 B-ROLL", "02 B-ROLL/Own"). */
export function binPaths(project: Project, extra: string[] = []): string[] {
  const out = new Set<string>();
  for (const b of [...project.bins, ...project.media.map((m) => m.bin), ...extra]) {
    const parts = b.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort();
}

export const SEQUENCE_BIN = "09 SEQUENCES";

/**
 * After an XML import, decide where each imported item goes:
 * clips → their IR bin by media path; sequences → 09 SEQUENCES; import bins → deleted.
 */
export function planImportedMoves(project: Project, items: ImportedItem[]): { moves: { nodeId: string; bin: string }[]; deleteBins: string[]; unmatched: ImportedItem[] } {
  const binByPath = new Map(project.media.map((m) => [normalizePath(m.path), m.bin]));
  const moves: { nodeId: string; bin: string }[] = [];
  const unmatched: ImportedItem[] = [];
  for (const it of items) {
    if (it.kind === "sequence") moves.push({ nodeId: it.nodeId, bin: SEQUENCE_BIN });
    else if (it.kind === "clip" || it.kind === "file") {
      const bin = it.mediaPath ? binByPath.get(normalizePath(it.mediaPath)) : undefined;
      if (bin) moves.push({ nodeId: it.nodeId, bin });
      else unmatched.push(it);
    }
  }
  // Delete imported bins deepest-first; host only deletes bins that end up empty.
  const bins = items.filter((i) => i.kind === "bin");
  const depth = (b: ImportedItem): number => {
    let d = 0;
    let p = b.parentNodeId;
    while (p) {
      d++;
      p = items.find((x) => x.nodeId === p)?.parentNodeId ?? null;
    }
    return d;
  };
  const deleteBins = bins.sort((a, b) => depth(b) - depth(a)).map((b) => b.nodeId);
  return { moves, deleteBins, unmatched };
}

/** Host readback (ticks) → backend-neutral snapshot (frames). */
export function snapshotFromRaw(raw: RawSequence, rate: Rate): SequenceSnapshot {
  const track = (items: RawTrackItem[]) => ({
    items: items
      .map((c) => ({
        path: normalizePath(c.mediaPath),
        start: ticksToFrames(c.start, rate),
        end: ticksToFrames(c.end, rate),
        in: ticksToFrames(c.inPoint, rate),
        name: c.name,
      }))
      .sort((a, b) => a.start - b.start),
  });
  return {
    name: raw.name,
    video: raw.video.map(track),
    audio: raw.audio.map(track),
    markers: raw.markers.map((m) => ({ frame: ticksToFrames(m.start, rate), name: m.name })),
  };
}
