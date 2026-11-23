import { mkdtempSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { assertProject, framesToTicks } from "@editz/ir";
import { parseFcp7Xml } from "@editz/compilers";
import { twentyClipProject } from "../../../packages/ir/test/fixtures.ts";
import { Bridge } from "../src/bridge.ts";
import { buildSequence, uniqueName, type Requester } from "../src/build.ts";
import { classify, scanFolder } from "../src/organize.ts";
import { ensureToken } from "../src/paths.ts";
import { tiersFor } from "../src/probe.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "editz-"));

describe("probe tiers", () => {
  it.each([
    ["11.1", ["xml"]],
    ["12.0", ["cep", "xml"]],
    ["24.6.1", ["cep", "xml"]],
    ["25.5", ["cep", "xml"]],
    ["25.6", ["uxp", "cep", "xml"]],
    ["26.0", ["uxp", "xml"]],
  ])("%s → %j", (v, want) => expect(tiersFor(v)).toEqual(want));
});

describe("organize v0", () => {
  it.each([
    ["Footage/B-Roll/city.mp4", "02 B-ROLL"],
    ["interview_camA_take3.mov", "01 A-ROLL"],
    ["pexels-ocean-1234.mp4", "02 B-ROLL"],
    ["clip0001.mp4", "99 UNSORTED"],
    ["Audio/music_bed_upbeat.wav", "03 MUSIC"],
    ["vo_take2.wav", "04 VOICE-OVER"],
    ["whoosh_fast.wav", "05 SFX"],
    ["volcano_rumble.wav", "99 UNSORTED"],
    ["logo.png", "06 GRAPHICS"],
    ["title_card.mogrt", "06 GRAPHICS"],
    ["IMG_2201.jpg", "07 STILLS"],
    ["brief.pdf", "08 REFERENCES"],
  ])("%s → %s", (rel, bin) => expect(classify(`/x/${rel}`, rel)?.bin).toBe(bin));

  it("skips project/cache files and uses only root-relative context", () => {
    const root = join(tmp(), "B-Roll main shoot");
    mkdirSync(join(root, "Adobe Premiere Pro Auto-Save"), { recursive: true });
    for (const f of ["a.mp4", "x.prproj", ".hidden.mov", "Adobe Premiere Pro Auto-Save/y.prproj"]) writeFileSync(join(root, f), "");
    const plan = scanFolder(root);
    expect(plan.items.map((i) => i.bin)).toEqual(["99 UNSORTED"]); // root name "B-Roll" must not leak
  });
});

describe("token", () => {
  it("creates a 0600 token and reuses it", () => {
    const d = tmp();
    const a = ensureToken(d);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureToken(d)).toBe(a);
    expect(statSync(join(d, "bridge-token")).mode & 0o777).toBe(0o600);
  });
});

describe("bridge", () => {
  let bridge: Bridge | undefined;
  afterEach(async () => bridge?.stop());

  const start = async () => {
    bridge = new Bridge({ token: "t".repeat(64), port: 0 as number, log: () => {} });
    // port 0 → pick a free port; read it back from the server.
    await bridge.start();
    const port = ((bridge as any).wss.address() as { port: number }).port;
    return port;
  };
  const panel = (port: number, token: string, headers?: Record<string, string>) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/premiere`, { headers });
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, backend: "cep", info: { appVersion: "24.6" } })));
      ws.on("message", (d) => JSON.parse(String(d)).type === "welcome" && resolve(ws));
      ws.on("close", (code) => reject(new Error(`closed ${code}`)));
    });

  it("authenticates a panel and round-trips an op", async () => {
    const port = await start();
    const ws = await panel(port, "t".repeat(64));
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.op === "info") ws.send(JSON.stringify({ id: m.id, ok: true, result: { appVersion: "24.6" } }));
      if (m.op === "readSequence") ws.send(JSON.stringify({ id: m.id, ok: false, error: "Sequence not found: x" }));
    });
    expect(bridge!.connected?.backend).toBe("cep");
    await expect(bridge!.request("info")).resolves.toEqual({ appVersion: "24.6" });
    await expect(bridge!.request("readSequence", { name: "x" })).rejects.toThrow(/not found/);
    ws.close();
  });

  it("rejects a wrong token and a foreign web origin", async () => {
    const port = await start();
    await expect(panel(port, "nope")).rejects.toThrow(/4001/);
    await expect(panel(port, "t".repeat(64), { Origin: "https://evil.example" })).rejects.toThrow(/4003/);
    expect(bridge!.connected).toBeNull();
  });

  it("times out and fails fast with no panel", async () => {
    const port = await start();
    await expect(bridge!.request("info")).rejects.toThrow(/No Premiere panel/);
    const ws = await panel(port, "t".repeat(64));
    await expect(bridge!.request("info", {}, 50)).rejects.toThrow(/did not answer/);
    ws.close();
  });
});

describe("build_sequence", () => {
  const p = assertProject(twentyClipProject());

  it("no panel → writes importable XML with bins and a plain next step", async () => {
    const out = tmp();
    const r = await buildSequence(p, { outDir: out, now: new Date("2026-01-01T00:00:00Z") });
    expect(r.route).toBe("xml-guided");
    expect(r.nextStep).toMatch(/File → Import/);
    const xml = readFileSync(r.xmlPath, "utf8");
    expect(xml).toContain("<bin>");
    expect(parseFcp7Xml(xml)[0]!.name).toBe("Golden 20 - Main");
  });

  it("CEP panel → full flow with readback match, renames on name clash", async () => {
    const seq = p.sequences[0]!;
    const media = new Map(p.media.map((m) => [m.id, m]));
    const t = (f: number) => framesToTicks(f, seq.rate).toString();
    const calls: string[] = [];
    const fake: Requester = {
      connected: { appVersion: "24.6", projectPath: null, projectName: null, hasQE: true, hasEncoder: true, backend: "cep" },
      async request<T>(op: string, args: any): Promise<T> {
        calls.push(op);
        const res: Record<string, unknown> = {
          listSequences: { sequences: [{ name: seq.name }] },
          ensureBins: { nodeIds: [] },
          importXml: {
            items: [
              { nodeId: "B", parentNodeId: null, name: "x.xml", kind: "bin", mediaPath: null },
              ...p.media.map((m, i) => ({ nodeId: `c${i}`, parentNodeId: "B", name: m.id, kind: "clip", mediaPath: m.path })),
              { nodeId: "S", parentNodeId: "B", name: `${seq.name} (2)`, kind: "sequence", mediaPath: null },
            ],
          },
          moveItems: { moved: args?.moves?.length ?? 0, missing: [] },
          deleteBins: { deleted: 1 },
          readSequence: {
            name: args?.name,
            video: seq.video.map((tr) => tr.items.map((c) => ({ name: c.id, mediaPath: media.get(c.media_id)!.path, start: t(c.start), end: t(c.end), inPoint: t(c.in) }))),
            audio: seq.audio.map((tr) => tr.items.map((c) => ({ name: c.id, mediaPath: media.get(c.media_id)!.path, start: t(c.start), end: t(c.end), inPoint: t(c.in) }))),
            markers: seq.markers.map((m) => ({ start: t(m.frame), name: m.name })),
          },
        };
        return res[op] as T;
      },
    };
    const r = await buildSequence(p, { bridge: fake, outDir: tmp() });
    expect(r.route).toBe("cep-live");
    expect(r.sequence).toBe("Golden 20 - Main (2)");
    expect(r.compare?.match).toBe(true);
    expect(r.unmatched).toEqual([]);
    expect(calls).toEqual(["listSequences", "ensureBins", "importXml", "moveItems", "deleteBins", "readSequence"]);
  });

  it("uniqueName", () => {
    expect(uniqueName("A", new Set(["A", "A (2)"]))).toBe("A (3)");
  });
});
