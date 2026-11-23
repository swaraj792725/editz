import { describe, expect, it } from "vitest";
import {
  assertProject,
  compareSnapshots,
  framesToTicks,
  parseProject,
  PPRO_TICKS_PER_SECOND,
  sequenceDuration,
  snapshotFromIr,
  ticksToFrames,
  toXmlRate,
  fromXmlRate,
} from "../src/index.ts";
import { twentyClipProject } from "./fixtures.ts";

describe("time", () => {
  const rates = [
    { num: 24000, den: 1001 },
    { num: 24, den: 1 },
    { num: 25, den: 1 },
    { num: 30000, den: 1001 },
    { num: 30, den: 1 },
    { num: 50, den: 1 },
    { num: 60000, den: 1001 },
    { num: 60, den: 1 },
  ];
  it("frames → ticks → frames is lossless for standard rates", () => {
    for (const r of rates) for (const f of [0, 1, 29, 1798, 107892, 1_000_000]) expect(ticksToFrames(framesToTicks(f, r), r)).toBe(f);
  });
  it("one second at 30 fps = PPRO ticks", () => {
    expect(framesToTicks(30, { num: 30, den: 1 })).toBe(BigInt(PPRO_TICKS_PER_SECOND));
  });
  it("ticks as decimal string (ExtendScript readback) parse", () => {
    expect(ticksToFrames("8475667200", { num: 30000, den: 1001 })).toBe(1);
  });
  it("xml rate round trip", () => {
    for (const r of rates) {
      const x = toXmlRate(r);
      expect(fromXmlRate(x.timebase, x.ntsc)).toEqual(r);
    }
    expect(() => toXmlRate({ num: 12345, den: 100 })).toThrow();
  });
});

describe("validate", () => {
  it("golden 20-clip project is valid with 20 timeline clips", () => {
    const p = assertProject(twentyClipProject());
    const seq = p.sequences[0]!;
    const clips = [...seq.video, ...seq.audio].reduce((n, t) => n + t.items.length, 0);
    expect(clips).toBe(30); // 10 V1 + 6 V2 + 10 A1 (linked) + 1 music + 3 VO
    const unique = seq.video.reduce((n, t) => n + t.items.length, 0) + seq.audio.slice(1).reduce((n, t) => n + t.items.length, 0);
    expect(unique).toBe(20);
    expect(sequenceDuration(seq)).toBe(1770);
  });
  it("catches overlaps, unknown media, source overrun", () => {
    const bad = twentyClipProject();
    const v1 = bad.sequences[0]!.video[0]!.items;
    v1[1]!.start = v1[0]!.start + 10;
    v1[2]!.media_id = "nope";
    v1[3]!.in = 3590;
    const { issues } = parseProject(bad);
    expect(issues.length).toBeGreaterThanOrEqual(3);
    const text = issues.map((i) => i.message).join("\n");
    expect(text).toMatch(/overlap/i);
    expect(text).toMatch(/nope/);
    expect(text).toMatch(/beyond|past|exceed/i);
  });
  it("rejects end <= start at schema level", () => {
    const bad = twentyClipProject();
    bad.sequences[0]!.video[1]!.items[0]!.end = bad.sequences[0]!.video[1]!.items[0]!.start;
    expect(parseProject(bad).project).toBeUndefined();
  });
});

describe("compare", () => {
  it("identical snapshots score 1", () => {
    const p = assertProject(twentyClipProject());
    const s = snapshotFromIr(p, p.sequences[0]!);
    expect(compareSnapshots(s, structuredClone(s))).toEqual({ match: true, score: 1, diffs: [] });
  });
  it("reports a shifted clip and a missing marker", () => {
    const p = assertProject(twentyClipProject());
    const s = snapshotFromIr(p, p.sequences[0]!);
    const a = structuredClone(s);
    a.video[1]!.items[0]!.start += 1;
    a.markers.pop();
    const r = compareSnapshots(s, a);
    expect(r.match).toBe(false);
    expect(r.diffs.some((d) => d.startsWith("video2"))).toBe(true);
    expect(r.diffs.some((d) => d.includes('"CTA"'))).toBe(true);
    expect(r.score).toBeLessThan(1);
  });
  it("paths match across file:// URL and unicode forms", () => {
    const p = assertProject(twentyClipProject("/Users/Shared/Café Media"));
    const s = snapshotFromIr(p, p.sequences[0]!);
    const a = structuredClone(s);
    a.video[0]!.items[0]!.path = "file://localhost/Users/Shared/Cafe%CC%81%20Media/aroll_01.mp4";
    expect(compareSnapshots(s, a).match).toBe(true);
  });
});
