import { sequenceDuration, toXmlRate, type MediaRef, type Project, type Rate, type Sequence } from "@editz/ir";

/**
 * IR → FCP7 XML (xmeml v4), the format every Premiere version since CS5 imports.
 * Premiere does NOT import FCPXML (Final Cut X); this is the older FCP7 dialect.
 */

export interface Fcp7Options {
  /** Wrap in <project> with bins holding master clips (file-interchange tier). */
  includeBins?: boolean;
  /** Only emit these sequences (by name). Default: all. */
  sequences?: string[];
}

type Node = { tag: string; attrs?: Record<string, string | number>; children?: (Node | string)[] };

const el = (tag: string, children?: (Node | string)[] | string | number, attrs?: Node["attrs"]): Node => ({
  tag,
  attrs,
  children: children === undefined ? undefined : Array.isArray(children) ? children : [String(children)],
});

function render(n: Node, depth = 0): string {
  const pad = "  ".repeat(depth);
  const attrs = n.attrs
    ? Object.entries(n.attrs)
        .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
        .join("")
    : "";
  if (!n.children || n.children.length === 0) return `${pad}<${n.tag}${attrs}/>`;
  if (n.children.every((c) => typeof c === "string")) {
    return `${pad}<${n.tag}${attrs}>${esc((n.children as string[]).join(""))}</${n.tag}>`;
  }
  const inner = n.children.map((c) => (typeof c === "string" ? pad + "  " + esc(c) : render(c, depth + 1))).join("\n");
  return `${pad}<${n.tag}${attrs}>\n${inner}\n${pad}</${n.tag}>`;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Absolute POSIX or Windows path → file://localhost URL as Premiere writes it. */
export function pathToUrl(p: string): string {
  const posix = p.replace(/\\/g, "/");
  const withSlash = /^[A-Za-z]:/.test(posix) ? "/" + posix : posix;
  return "file://localhost" + withSlash.split("/").map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":")).join("/");
}

function rateNode(rate: Rate): Node {
  const r = toXmlRate(rate);
  return el("rate", [el("timebase", r.timebase), el("ntsc", r.ntsc ? "TRUE" : "FALSE")]);
}

function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

class FileRegistry {
  private seen = new Set<string>();
  constructor(private rate: Rate, private seqAudioRate: number) {}
  fileId(m: MediaRef) {
    return `file-${m.id}`;
  }
  /** First use emits the full <file>, later uses a bare reference. */
  node(m: MediaRef): Node {
    const id = this.fileId(m);
    if (this.seen.has(id)) return el("file", undefined, { id });
    this.seen.add(id);
    const media: Node[] = [];
    if (m.has_video) {
      const sc: Node[] = [];
      if (m.width) sc.push(el("width", m.width));
      if (m.height) sc.push(el("height", m.height));
      media.push(el("video", [el("samplecharacteristics", [rateNode(this.rate), ...sc])]));
    }
    if (m.has_audio) {
      media.push(
        el("audio", [
          el("samplecharacteristics", [el("depth", 16), el("samplerate", this.seqAudioRate)]),
          el("channelcount", m.audio_channels),
        ]),
      );
    }
    return el(
      "file",
      [
        el("name", baseName(m.path)),
        el("pathurl", pathToUrl(m.path)),
        rateNode(this.rate),
        el("duration", m.duration),
        el("media", media),
      ],
      { id },
    );
  }
}

export function projectToFcp7Xml(project: Project, opts: Fcp7Options = {}): string {
  const seqs = project.sequences.filter((s) => !opts.sequences || opts.sequences.includes(s.name));
  if (seqs.length === 0) throw new Error("no sequences to emit");
  const first = seqs[0]!;
  const files = new FileRegistry(first.rate, first.audio_rate);
  const media = new Map(project.media.map((m) => [m.id, m]));

  const body: Node[] = [];
  if (opts.includeBins) {
    body.push(
      el("project", [el("name", project.name), el("children", [...binNodes(project, files, first.rate), ...seqs.map((s) => sequenceNode(s, media, files))])]),
    );
  } else {
    body.push(...seqs.map((s) => sequenceNode(s, media, files)));
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n${render(el("xmeml", body, { version: 4 }))}\n`;
}

/** Nested bins ("02 B-ROLL/Own") with a master <clip> per media item. */
function binNodes(project: Project, files: FileRegistry, rate: Rate): Node[] {
  type Tree = { name: string; kids: Map<string, Tree>; clips: MediaRef[] };
  const root: Tree = { name: "", kids: new Map(), clips: [] };
  const ensure = (path: string) => {
    let cur = root;
    for (const part of path.split("/").filter(Boolean)) {
      if (!cur.kids.has(part)) cur.kids.set(part, { name: part, kids: new Map(), clips: [] });
      cur = cur.kids.get(part)!;
    }
    return cur;
  };
  project.bins.forEach(ensure);
  project.media.forEach((m) => ensure(m.bin).clips.push(m));

  const toNode = (t: Tree): Node =>
    el("bin", [
      el("name", t.name),
      el("children", [
        ...[...t.kids.values()].map(toNode),
        ...t.clips.map((m) =>
          el("clip", [el("name", baseName(m.path)), el("duration", m.duration), rateNode(rate), el("media", masterMedia(m, files))], {
            id: `masterclip-${m.id}`,
          }),
        ),
      ]),
    ]);
  return [...root.kids.values()].map(toNode);
}

function masterMedia(m: MediaRef, files: FileRegistry): Node[] {
  const out: Node[] = [];
  const f = files.node(m);
  if (m.has_video) out.push(el("video", [el("track", [el("clipitem", [el("name", baseName(m.path)), f])])]));
  if (m.has_audio) out.push(el("audio", [el("track", [el("clipitem", [el("name", baseName(m.path)), m.has_video ? el("file", undefined, { id: files.fileId(m) }) : f])])]));
  return out;
}

function sequenceNode(seq: Sequence, media: Map<string, MediaRef>, files: FileRegistry): Node {
  const dur = sequenceDuration(seq);
  const r = toXmlRate(seq.rate);
  const dropFrame = r.ntsc && (r.timebase === 30 || r.timebase === 60);

  // Link V/A items that share media + timing so Premiere keeps them linked.
  const linkKey = (mid: string, s: number, e: number, i: number) => `${mid}|${s}|${e}|${i}`;
  const linkMap = new Map<string, { id: string; kind: "video" | "audio"; track: number; index: number }[]>();
  const collect = (kind: "video" | "audio") =>
    seq[kind].forEach((t, ti) =>
      t.items.forEach((c, ci) => {
        const k = linkKey(c.media_id, c.start, c.end, c.in);
        if (!linkMap.has(k)) linkMap.set(k, []);
        linkMap.get(k)!.push({ id: c.id, kind, track: ti + 1, index: ci + 1 });
      }),
    );
  collect("video");
  collect("audio");

  const clipNode = (kind: "video" | "audio", c: Sequence["video"][number]["items"][number]): Node => {
    const m = media.get(c.media_id);
    if (!m) throw new Error(`unknown media ${c.media_id}`);
    const kids: Node[] = [
      el("name", c.name ?? baseName(m.path)),
      el("enabled", c.enabled ? "TRUE" : "FALSE"),
      el("duration", m.duration),
      rateNode(seq.rate),
      el("start", c.start),
      el("end", c.end),
      el("in", c.in),
      el("out", c.in + (c.end - c.start)),
      files.node(m),
    ];
    if (kind === "audio") {
      kids.push(el("sourcetrack", [el("mediatype", "audio"), el("trackindex", 1)]));
      const lv = levelsFilter(c);
      if (lv) kids.push(lv);
    }
    const links = linkMap.get(linkKey(c.media_id, c.start, c.end, c.in)) ?? [];
    if (links.length > 1 && links.some((l) => l.kind === "video") && links.some((l) => l.kind === "audio")) {
      for (const l of links) {
        kids.push(
          el("link", [
            el("linkclipref", `clipitem-${l.id}`),
            el("mediatype", l.kind),
            el("trackindex", l.track),
            el("clipindex", l.index),
          ]),
        );
      }
    }
    return el("clipitem", kids, { id: `clipitem-${c.id}` });
  };

  const sortedTrack = (kind: "video" | "audio", items: Sequence["video"][number]["items"]) =>
    [...items].sort((a, b) => a.start - b.start).map((c) => clipNode(kind, c));

  const video = el("video", [
    el("format", [
      el("samplecharacteristics", [rateNode(seq.rate), el("width", seq.width), el("height", seq.height), el("pixelaspectratio", "square"), el("fielddominance", "none")]),
    ]),
    ...seq.video.map((t) => el("track", sortedTrack("video", t.items))),
  ]);
  const audio = el("audio", [
    el("numOutputChannels", 2),
    el("format", [el("samplecharacteristics", [el("depth", 16), el("samplerate", seq.audio_rate)])]),
    ...seq.audio.map((t) => el("track", sortedTrack("audio", t.items), { premiereTrackType: "Stereo" })),
  ]);

  const markers = seq.markers.map((mk) =>
    el("marker", [el("name", mk.name), el("comment", mk.comment), el("in", mk.frame), el("out", mk.duration > 0 ? mk.frame + mk.duration : -1)]),
  );

  return el(
    "sequence",
    [
      el("name", seq.name),
      el("duration", dur),
      rateNode(seq.rate),
      el("timecode", [rateNode(seq.rate), el("string", dropFrame ? "00;00;00;00" : "00:00:00:00"), el("frame", 0), el("displayformat", dropFrame ? "DF" : "NDF")]),
      el("media", [video, audio]),
      ...markers,
    ],
    { id: `sequence-${slug(seq.name)}` },
  );
}

/** dB → the linear gain FCP7 XML stores (0 dB = 1, +12 dB ≈ 3.98, Premiere's max). */
export function dbToGain(db: number): number {
  return Math.round(Math.min(Math.pow(10, db / 20), 3.98109) * 1e6) / 1e6;
}

/**
 * Audio Levels effect for clip gain and volume keyframes. Keyframe <when> is counted
 * in frames from the clip item's start. [verify against a Premiere export when the
 * in point is not 0; in = 0 is unambiguous]
 */
function levelsFilter(c: Sequence["audio"][number]["items"][number]): Node | null {
  const gain = c.gain_db ?? 0;
  const keys = [...(c.levels ?? [])].sort((a, b) => a.frame - b.frame);
  if (!keys.length && gain === 0) return null;
  const param: Node[] = [
    el("parameterid", "level"),
    el("name", "Level"),
    el("valuemin", 0),
    el("valuemax", 3.98109),
    el("value", dbToGain((keys[0]?.db ?? 0) + gain)),
    ...keys.map((k) => el("keyframe", [el("when", k.frame), el("value", dbToGain(k.db + gain))])),
  ];
  return el("filter", [
    el("effect", [
      el("name", "Audio Levels"),
      el("effectid", "audiolevels"),
      el("effectcategory", "audiolevels"),
      el("effecttype", "audiolevels"),
      el("mediatype", "audio"),
      el("parameter", param, { authoringApp: "PremierePro" }),
    ]),
  ]);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "seq";
}
