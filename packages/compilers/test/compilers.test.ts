import { describe, expect, it } from "vitest";
import { assertProject, compareSnapshots, framesToTicks, snapshotFromIr, type Project } from "@editz/ir";
import { twentyClipProject } from "../../ir/test/fixtures.ts";
import {
  binPaths,
  parseFcp7Xml,
  pathToUrl,
  planImportedMoves,
  projectToFcp7Xml,
  snapshotFromRaw,
  SEQUENCE_BIN,
  type ImportedItem,
  type RawSequence,
} from "../src/index.ts";

const golden = (root?: string) => assertProject(twentyClipProject(root));

describe("FCP7 XML emit/parse", () => {
  it("round-trips the golden 20-clip sequence with score 1", () => {
    const p = golden();
    const xml = projectToFcp7Xml(p);
    const [seq] = parseFcp7Xml(xml);
    expect(seq).toBeDefined();
    const r = compareSnapshots(snapshotFromIr(p, p.sequences[0]!), seq!);
    expect(r.diffs).toEqual([]);
    expect(r.score).toBe(1);
    expect(seq!.rate).toEqual({ num: 30000, den: 1001 });
    expect(seq!.width).toBe(1920);
    expect(seq!.duration).toBe(1770);
  });

  it("round-trips with bins wrapper and awkward paths", () => {
    const p = golden("/Volumes/Media Drive/Café & <Co>/50% off");
    const xml = projectToFcp7Xml(p, { includeBins: true });
    expect(xml).toContain("<bin>");
    expect(xml).toContain("Caf%C3%A9%20%26%20%3CCo%3E");
    const seqs = parseFcp7Xml(xml);
    expect(seqs).toHaveLength(1);
    expect(compareSnapshots(snapshotFromIr(p, p.sequences[0]!), seqs[0]!).match).toBe(true);
  });

  it("emits each <file> in full once, bare refs after", () => {
    const xml = projectToFcp7Xml(golden());
    const full = xml.match(/<file id="file-a1">/g) ?? [];
    expect(full).toHaveLength(1);
    expect(xml).toContain('<file id="file-a1"/>');
  });

  it("drop-frame timecode only for 29.97/59.94", () => {
    const p = golden();
    expect(projectToFcp7Xml(p)).toContain("<displayformat>DF</displayformat>");
    const p24: Project = { ...p, sequences: [{ ...p.sequences[0]!, rate: { num: 24000, den: 1001 } }] };
    expect(projectToFcp7Xml(p24)).toContain("<displayformat>NDF</displayformat>");
  });

  it("links A-roll video and audio", () => {
    const xml = projectToFcp7Xml(golden());
    expect(xml).toContain("<linkclipref>clipitem-a1c1</linkclipref>");
    expect(xml).toContain("<linkclipref>clipitem-v1c1</linkclipref>");
  });

  it("pathToUrl encodes POSIX and Windows paths", () => {
    expect(pathToUrl("/Users/a b/c#d.mp4")).toBe("file://localhost/Users/a%20b/c%23d.mp4");
    expect(pathToUrl("C:\\Media\\x.mov")).toBe("file://localhost/C:/Media/x.mov");
  });
});

describe("ExtendScript op planning", () => {
  it("binPaths expands parents and sorts", () => {
    expect(binPaths(golden())).toEqual(["01 A-ROLL", "02 B-ROLL", "02 B-ROLL/Own", "03 MUSIC", "04 VOICE-OVER", "09 SEQUENCES", "99 UNSORTED"].filter((b) => b !== "99 UNSORTED"));
  });

  it("planImportedMoves routes clips by path, sequences to 09, deletes import bins deepest-first", () => {
    const p = golden();
    const root = "/Users/Shared/Editz Golden/media";
    const items: ImportedItem[] = [
      { nodeId: "X", parentNodeId: null, name: "golden.xml", kind: "bin", mediaPath: null },
      { nodeId: "Y", parentNodeId: "X", name: "02 B-ROLL", kind: "bin", mediaPath: null },
      { nodeId: "Z", parentNodeId: "Y", name: "Own", kind: "bin", mediaPath: null },
      { nodeId: "c1", parentNodeId: "Z", name: "broll_01.mp4", kind: "clip", mediaPath: `${root}/broll_01.mp4` },
      { nodeId: "c2", parentNodeId: "X", name: "aroll_01.mp4", kind: "clip", mediaPath: `${root}/aroll_01.mp4` },
      { nodeId: "s1", parentNodeId: "X", name: "Golden 20 - Main", kind: "sequence", mediaPath: null },
      { nodeId: "c3", parentNodeId: "X", name: "stray.mov", kind: "clip", mediaPath: "/elsewhere/stray.mov" },
    ];
    const plan = planImportedMoves(p, items);
    expect(plan.moves).toEqual([
      { nodeId: "c1", bin: "02 B-ROLL/Own" },
      { nodeId: "c2", bin: "01 A-ROLL" },
      { nodeId: "s1", bin: SEQUENCE_BIN },
    ]);
    expect(plan.deleteBins).toEqual(["Z", "Y", "X"]);
    expect(plan.unmatched.map((u) => u.nodeId)).toEqual(["c3"]);
  });

  it("snapshotFromRaw converts host ticks and matches IR", () => {
    const p = golden();
    const seq = p.sequences[0]!;
    const media = new Map(p.media.map((m) => [m.id, m]));
    const t = (f: number) => framesToTicks(f, seq.rate).toString();
    const toRaw = (tracks: typeof seq.video) =>
      tracks.map((tr) => tr.items.map((c) => ({ name: c.id, mediaPath: media.get(c.media_id)!.path, start: t(c.start), end: t(c.end), inPoint: t(c.in) })));
    const raw: RawSequence = {
      name: seq.name,
      video: toRaw(seq.video),
      audio: toRaw(seq.audio),
      markers: seq.markers.map((m) => ({ start: t(m.frame), name: m.name })),
    };
    const r = compareSnapshots(snapshotFromIr(p, seq), snapshotFromRaw(raw, seq.rate));
    expect(r.diffs).toEqual([]);
  });
});
