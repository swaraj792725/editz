import { XMLParser } from "fast-xml-parser";
import { fromXmlRate, normalizePath, type Rate, type SequenceSnapshot, type SnapshotTrack } from "@editz/ir";

/**
 * FCP7 XML → SequenceSnapshot[]. Used to (a) round-trip test our emitter and
 * (b) read back sequences Premiere exports on versions without live scripting.
 */

const ARRAYS = new Set(["sequence", "track", "clipitem", "marker", "bin", "clip", "link", "generatoritem", "transitionitem"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAYS.has(name),
});

type X = Record<string, any>;

export interface ParsedSequence extends SequenceSnapshot {
  rate: Rate;
  width?: number;
  height?: number;
  duration: number;
}

export function parseFcp7Xml(xml: string): ParsedSequence[] {
  const doc = parser.parse(xml) as X;
  const root = doc.xmeml;
  if (!root) throw new Error("not an xmeml document");

  // file ids are document-global: collect every full <file> definition first.
  const files = new Map<string, string>();
  walk(root, (k, v) => {
    if (k === "file" && v && typeof v === "object" && v["@_id"] && v.pathurl) files.set(v["@_id"], normalizePath(String(v.pathurl)));
  });

  const seqs: X[] = [];
  walk(root, (k, v) => {
    if (k === "sequence" && v && typeof v === "object" && v.media) seqs.push(v);
  });

  return seqs.map((s) => {
    const rate = readRate(s.rate);
    const track = (t: X): SnapshotTrack => ({
      items: (t.clipitem ?? [])
        .filter((c: X) => String(c.enabled ?? "TRUE").toUpperCase() !== "FALSE")
        .map((c: X) => {
          const f = c.file;
          const id = f?.["@_id"];
          const path = (f?.pathurl ? normalizePath(String(f.pathurl)) : files.get(id)) ?? "";
          return { path, start: int(c.start), end: int(c.end), in: int(c.in), name: c.name ? String(c.name) : undefined };
        })
        .sort((a: { start: number }, b: { start: number }) => a.start - b.start),
    });
    const fmt = s.media?.video?.format?.samplecharacteristics;
    return {
      name: String(s.name ?? ""),
      rate,
      width: fmt?.width ? int(fmt.width) : undefined,
      height: fmt?.height ? int(fmt.height) : undefined,
      duration: int(s.duration ?? 0),
      video: (s.media?.video?.track ?? []).map(track),
      audio: (s.media?.audio?.track ?? []).map(track),
      markers: (s.marker ?? []).map((m: X) => ({ frame: int(m.in), name: String(m.name ?? "") })),
    };
  });
}

function readRate(r: X | undefined): Rate {
  if (!r) return { num: 30, den: 1 };
  return fromXmlRate(int(r.timebase), String(r.ntsc).toUpperCase() === "TRUE");
}

function int(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected number, got ${String(v)}`);
  return Math.round(n);
}

function walk(node: unknown, fn: (key: string, value: any) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, fn));
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v)) v.forEach((x) => fn(k, x));
    else fn(k, v);
    walk(v, fn);
  }
}
