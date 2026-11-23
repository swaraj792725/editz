import type { Project, Sequence } from "./schema.ts";

/**
 * Backend-neutral view of a sequence, as read back from Premiere (or parsed from XML).
 * Clips are identified by media path because Premiere does not keep our ids.
 */
export interface SnapshotClip {
  path: string;
  start: number;
  end: number;
  in: number;
  name?: string;
}
export interface SnapshotTrack {
  items: SnapshotClip[];
}
export interface SequenceSnapshot {
  name: string;
  video: SnapshotTrack[];
  audio: SnapshotTrack[];
  markers: { frame: number; name: string }[];
}

export interface CompareResult {
  match: boolean;
  /** Fraction of expected clips + markers found exactly. 1 = perfect. */
  score: number;
  diffs: string[];
}

export function normalizePath(p: string): string {
  let s = p.replace(/^file:\/\/(localhost)?/i, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  return s.replace(/\\/g, "/").normalize("NFC");
}

export function snapshotFromIr(project: Project, seq: Sequence): SequenceSnapshot {
  const media = new Map(project.media.map((m) => [m.id, m]));
  const track = (t: Sequence["video"][number]): SnapshotTrack => ({
    items: t.items
      .filter((c) => c.enabled)
      .map((c) => ({ path: normalizePath(media.get(c.media_id)!.path), start: c.start, end: c.end, in: c.in }))
      .sort((a, b) => a.start - b.start),
  });
  return {
    name: seq.name,
    video: seq.video.map(track),
    audio: seq.audio.map(track),
    markers: seq.markers.map((m) => ({ frame: m.frame, name: m.name })),
  };
}

/** Compare expected (from IR) to actual (readback). Empty trailing tracks are ignored. */
export function compareSnapshots(expected: SequenceSnapshot, actual: SequenceSnapshot): CompareResult {
  const diffs: string[] = [];
  let total = 0;
  let ok = 0;

  const cmpTracks = (kind: "video" | "audio") => {
    const e = expected[kind];
    const a = actual[kind];
    const n = Math.max(e.length, a.length);
    for (let i = 0; i < n; i++) {
      const et = (e[i]?.items ?? []).slice().sort((x, y) => x.start - y.start);
      const at = (a[i]?.items ?? []).slice().sort((x, y) => x.start - y.start);
      const used = new Set<number>();
      for (const ec of et) {
        total++;
        const idx = at.findIndex(
          (ac, j) =>
            !used.has(j) &&
            normalizePath(ac.path) === normalizePath(ec.path) &&
            ac.start === ec.start &&
            ac.end === ec.end &&
            ac.in === ec.in,
        );
        if (idx >= 0) {
          used.add(idx);
          ok++;
        } else {
          const near = at.find((ac) => ac.start === ec.start);
          diffs.push(
            `${kind}${i + 1}: expected ${base(ec.path)} [${ec.start},${ec.end}) in=${ec.in}` +
              (near ? `, got ${base(near.path)} [${near.start},${near.end}) in=${near.in}` : ", missing"),
          );
        }
      }
      at.forEach((ac, j) => {
        if (!used.has(j)) diffs.push(`${kind}${i + 1}: unexpected ${base(ac.path)} [${ac.start},${ac.end})`);
      });
    }
  };
  cmpTracks("video");
  cmpTracks("audio");

  const am = actual.markers.slice();
  for (const m of expected.markers) {
    total++;
    const idx = am.findIndex((x) => x.frame === m.frame && x.name === m.name);
    if (idx >= 0) {
      am.splice(idx, 1);
      ok++;
    } else diffs.push(`marker "${m.name}" @${m.frame} missing`);
  }
  for (const m of am) diffs.push(`unexpected marker "${m.name}" @${m.frame}`);

  const score = total === 0 ? 1 : ok / total;
  return { match: diffs.length === 0, score, diffs };
}

function base(p: string): string {
  return normalizePath(p).split("/").pop() ?? p;
}
