/**
 * Runs host/editz.jsx in a Node vm against a mock of Premiere's ExtendScript
 * object model, then drives the full CEP-tier build flow the daemon will use.
 * The mock is only as good as our reading of the API docs; live test still needed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { assertProject, compareSnapshots, framesToTicks, snapshotFromIr, type Project } from "@editz/ir";
import { binPaths, planImportedMoves, snapshotFromRaw, type ImportedItem, type RawSequence } from "@editz/compilers";
import { twentyClipProject } from "../../../packages/ir/test/fixtures.ts";

const HOST = readFileSync(fileURLToPath(new URL("../host/editz.jsx", import.meta.url)), "utf8");

let nextId = 1000;
class Item {
  nodeId = String(nextId++);
  kids: Item[] = [];
  parent: Item | null = null;
  constructor(public name: string, public type: number, private media: string | null = null, private seq = false) {}
  get children() {
    const c: any = { numItems: this.kids.length };
    this.kids.forEach((k, i) => (c[i] = k));
    return c;
  }
  add(k: Item) {
    k.parent = this;
    this.kids.push(k);
    return k;
  }
  createBin(name: string) {
    return this.add(new Item(name, 2));
  }
  moveBin(dest: Item) {
    this.parent!.kids.splice(this.parent!.kids.indexOf(this), 1);
    dest.add(this);
  }
  deleteBin() {
    this.parent!.kids.splice(this.parent!.kids.indexOf(this), 1);
  }
  getMediaPath() {
    return this.media ?? "";
  }
  isSequence() {
    return this.seq;
  }
}

function mockPremiere(project: Project) {
  const root = new Item("root", 3);
  const seqs: any[] = [];
  const seqDef = project.sequences[0]!;
  const media = new Map(project.media.map((m) => [m.id, m]));
  const t = (f: number) => ({ ticks: framesToTicks(f, seqDef.rate).toString() });
  const tracks = (ts: typeof seqDef.video, items: Map<string, Item>) => {
    const out: any = { numTracks: ts.length };
    ts.forEach((tr, i) => {
      const clips: any = { numItems: tr.items.length };
      tr.items.forEach((c, j) => (clips[j] = { name: c.id, start: t(c.start), end: t(c.end), inPoint: t(c.in), projectItem: items.get(c.media_id) }));
      out[i] = { clips };
    });
    return out;
  };
  const markers = () => {
    const list = seqDef.markers.map((m) => ({ start: t(m.frame), name: m.name }));
    return { getFirstMarker: () => list[0] ?? null, getNextMarker: (m: any) => list[list.indexOf(m) + 1] ?? null, createMarker: () => ({}) };
  };
  const app = {
    version: "24.6.1",
    encoder: {},
    enableQE() {},
    project: {
      name: "Test.prproj",
      path: "/tmp/Test.prproj",
      rootItem: root,
      sequences: { get numSequences() { return seqs.length; } } as any,
      // Simulates Premiere's XML import: one bin named after the file, nested bins, master clips, sequence.
      importFiles(paths: string[], _s: boolean, target: Item) {
        const xmlBin = target.createBin("golden.xml");
        const byId = new Map<string, Item>();
        for (const m of project.media) {
          let cur = xmlBin;
          for (const part of m.bin.split("/")) cur = cur.kids.find((k) => k.name === part && k.type === 2) ?? cur.createBin(part);
          byId.set(m.id, cur.add(new Item(m.path.split("/").pop()!, 1, m.path)));
        }
        xmlBin.add(new Item(seqDef.name, 1, null, true));
        const s = { name: seqDef.name, sequenceID: "seq-1", videoTracks: tracks(seqDef.video, byId), audioTracks: tracks(seqDef.audio, byId), markers: markers() };
        seqs.push(s);
        (app.project.sequences as any)[seqs.length - 1] = s;
        return paths.length > 0;
      },
    },
  };
  const ctx = vm.createContext({ app, $: {} });
  vm.runInContext(HOST + "\nthis.EditzHost = EditzHost;", ctx);
  const call = <T>(op: string, args: unknown = {}): T => {
    const out = JSON.parse(ctx.EditzHost.call(op, JSON.stringify(args)));
    if (!out.ok) throw new Error(out.error);
    return out.result as T;
  };
  return { call, root, media };
}

function tree(it: Item, depth = 0): string[] {
  return it.kids.flatMap((k) => [`${"  ".repeat(depth)}${k.name}`, ...tree(k, depth + 1)]);
}

describe("ExtendScript host lib (mock Premiere)", () => {
  it("full CEP build flow: bins → importXml → move → delete → readback match", () => {
    const p = assertProject(twentyClipProject());
    const { call, root } = mockPremiere(p);

    expect(call<{ backend: string }>("info").backend).toBe("cep");
    call("ensureBins", { paths: binPaths(p) });
    const before = tree(root).length;
    call("ensureBins", { paths: binPaths(p) }); // idempotent
    expect(tree(root).length).toBe(before);

    const { items } = call<{ items: ImportedItem[] }>("importXml", { path: "/tmp/golden.xml" });
    expect(items.filter((i) => i.kind === "sequence")).toHaveLength(1);
    const plan = planImportedMoves(p, items);
    expect(plan.unmatched).toEqual([]);
    expect(call<{ moved: number }>("moveItems", { moves: plan.moves }).moved).toBe(16);
    call("deleteBins", { nodeIds: plan.deleteBins });

    expect(tree(root)).not.toContain("golden.xml");
    expect(tree(root)).toEqual([
      "01 A-ROLL", "  aroll_01.mp4", "  aroll_02.mp4", "  aroll_03.mp4", "  aroll_04.mp4", "  aroll_05.mp4",
      "02 B-ROLL", "  Own", "    broll_01.mp4", "    broll_02.mp4", "    broll_03.mp4", "    broll_04.mp4", "    broll_05.mp4", "    broll_06.mp4",
      "03 MUSIC", "  music_bed.wav",
      "04 VOICE-OVER", "  vo_01.wav", "  vo_02.wav", "  vo_03.wav",
      "09 SEQUENCES", "  Golden 20 - Main",
    ]);

    const raw = call<RawSequence>("readSequence", { name: "Golden 20 - Main" });
    const seq = p.sequences[0]!;
    const r = compareSnapshots(snapshotFromIr(p, seq), snapshotFromRaw(raw, seq.rate));
    expect(r.diffs).toEqual([]);
    expect(r.score).toBe(1);
  });

  it("returns structured errors, never throws across the bridge", () => {
    const { call } = mockPremiere(assertProject(twentyClipProject()));
    expect(() => call("readSequence", { name: "nope" })).toThrow(/Sequence not found/);
    expect(() => call("rm -rf")).toThrow(/Unknown op/);
  });

  it("attaches proxies by media path, case-insensitive, and reports misses", () => {
    const p = assertProject(twentyClipProject());
    const { call, root } = mockPremiere(p);
    call("importXml", { path: "/tmp/golden.xml" });
    const clips: any[] = [];
    const walk = (it: Item) => it.kids.forEach((k) => (k.getMediaPath() ? clips.push(k) : walk(k)));
    walk(root);
    let attached = 0;
    for (const c of clips) {
      c.proxy = null;
      c.canProxy = () => !String(c.getMediaPath()).includes("broll_06");
      c.attachProxy = (path: string, isHiRes: number) => ((c.proxy = path), attached++, expect(isHiRes).toBe(0));
      c.hasProxy = () => !!c.proxy;
    }
    const media = clips[0].getMediaPath() as string;
    const b6 = clips.find((c) => c.getMediaPath().includes("broll_06")).getMediaPath();
    const r = call<{ results: { media: string; attached: number; error?: string }[] }>("attachProxies", {
      pairs: [
        { media: media.toUpperCase(), proxy: "/px/a_Proxy.mp4" },
        { media: "/nope.mov", proxy: "/px/n.mp4" },
        { media: b6, proxy: "/px/b6.mp4" },
      ],
    });
    expect(r.results[0]).toEqual({ media: media.toUpperCase(), attached: 1 });
    expect(r.results[1]!.error).toMatch(/not in project/);
    expect(r.results[2]!.error).toMatch(/cannot take a proxy/);
    expect(attached).toBe(1);
  });

  it("stringify handles quotes, control chars, unicode", () => {
    const ctx = vm.createContext({ app: {} });
    vm.runInContext(HOST + "\nthis.EditzHost = EditzHost;", ctx);
    const v = { s: 'a"b\\c\n\t\u0001é😀', n: [1, 2.5, null, true], o: { x: "y" } };
    expect(JSON.parse(ctx.EditzHost._stringify(v))).toEqual(v);
  });
});
