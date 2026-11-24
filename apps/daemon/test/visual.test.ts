import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ingest } from "../src/media/analyze.ts";
import { findTool, probe, rawFrames, type MediaInfo } from "../src/media/ffmpeg.ts";
import { MediaIndex } from "../src/media/index-db.ts";
import { hexToLab, kmeans, labToHex, lookFit, lookProfile, rgbToLab } from "../src/media/look.ts";
import { makeProxies, proxyPlan } from "../src/media/proxy.ts";
import { clipTags, fit, frameTimes, moodShares, prob, searchMedia, topMoods, visualAnalyze, describeVisual, VISION_MODEL, MOODS } from "../src/media/visual.ts";
import type { WorkerLike } from "../src/speech/service.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "editz-s3-"));
const DIM = 32;
const unit = (axis: number) => {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  return v;
};
const b64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");

describe("frame sampling", () => {
  it("one frame per shot, evenly filled, inside the clip", () => {
    const t = frameTimes(10, [4], 2, 24);
    expect(t).toContain(2); // middle of shot 1
    expect(t).toContain(7); // middle of shot 2
    expect(Math.min(...t)).toBeGreaterThan(0);
    expect(Math.max(...t)).toBeLessThan(10);
    for (let i = 1; i < t.length; i++) expect(t[i]! - t[i - 1]!).toBeGreaterThanOrEqual(0.99);
  });

  it("caps long clips with an even spread", () => {
    const t = frameTimes(3600, [], 2, 24);
    expect(t.length).toBe(24);
    expect(t[0]!).toBeLessThan(5);
    expect(t.at(-1)!).toBeGreaterThan(3590);
  });

  it("handles tiny and empty clips", () => {
    expect(frameTimes(0)).toEqual([0]);
    expect(frameTimes(0.3).length).toBe(1);
  });
});

describe("look maths", () => {
  it("Lab: white, black, and hex round trip", () => {
    const [L, a, b] = rgbToLab(255, 255, 255);
    expect(L).toBeCloseTo(100, 0);
    expect(Math.abs(a) + Math.abs(b)).toBeLessThan(0.5);
    expect(rgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 1);
    expect(labToHex(hexToLab("#c0392b"))).toBe("#c0392b");
  });

  it("k-means splits two colours by share", () => {
    const pts = [...Array(30).fill(rgbToLab(230, 40, 30)), ...Array(10).fill(rgbToLab(20, 40, 220))];
    const c = kmeans(pts, 3).filter((x) => x.share > 0.01).sort((a, b) => b.share - a.share);
    expect(c.length).toBe(2);
    expect(c[0]!.share).toBeCloseTo(0.75, 2);
  });

  const solid = (r: number, g: number, b: number, n = 4) => ({ width: 8, height: 4, fps: 2, frames: Array.from({ length: n }, () => Buffer.from(Array.from({ length: 32 }, () => [r, g, b]).flat())) });

  it("profiles warm vs cool, still vs moving", () => {
    const warm = lookProfile(solid(220, 120, 40));
    const cool = lookProfile(solid(40, 90, 200));
    expect(warm.warmth).toBeGreaterThan(0);
    expect(cool.warmth).toBeLessThan(0);
    expect(warm.labels).toContain("warm");
    expect(cool.labels).toContain("cool");
    expect(warm.motion).toBe(0);
    expect(lookFit(warm, "warm")!).toBeGreaterThan(lookFit(cool, "warm")!);
    expect(lookFit(cool, "#2860c8")!).toBeGreaterThan(lookFit(warm, "#2860c8")!);
    expect(lookFit(warm, warm)!).toBeGreaterThan(lookFit(cool, warm)!);
    const flicker = { ...solid(0, 0, 0), frames: [solid(0, 0, 0).frames[0]!, solid(255, 255, 255).frames[0]!] };
    expect(lookProfile(flicker).motion).toBeGreaterThan(0.5);
  });
});

describe("scoring", () => {
  it("calibrated probability: matching high, unrelated ≈ 0", () => {
    expect(prob(0.2)).toBeGreaterThan(0.9);
    expect(prob(0.05)).toBeLessThan(0.01);
    expect([fit(0.02), fit(0.3)]).toEqual([0, 1]);
    expect(fit(0.1)).toBeCloseTo(0.5, 9);
  });

  it("tags keep the best frame; moods rank by share", () => {
    const frames = [{ t: 1, vec: unit(0) }, { t: 3, vec: unit(1) }];
    const tags = clipTags(frames, [{ tag: "a dog", group: "subject", vec: unit(1) }, { tag: "a cat", group: "subject", vec: unit(5) }]);
    expect(tags).toEqual([{ tag: "dog", group: "subject", fit: 1, at_s: 3 }]);
    const shares = moodShares(frames, [unit(0), unit(1), unit(7)]);
    expect(shares[0]).toBeCloseTo(0.5, 2);
    expect(shares[2]).toBeLessThan(0.01);
    expect(topMoods([0.1, 0.4, 0.2], ["calm", "cozy", "tense"], 2)).toEqual([{ mood: "cozy", fit: 1 }, { mood: "tense", fit: 0.5 }]);
  });
});

describe("proxy plan", () => {
  const v = (width: number, height: number, extra: Partial<MediaInfo> = {}) => ({ path: "/f/a.mov", durationSec: 5, hasVideo: true, hasAudio: true, isImage: false, width, height, audioChannels: 2, ...extra }) as MediaInfo;
  it("plans landscape, portrait, and skips light or still media", () => {
    expect(proxyPlan(v(3840, 2160), "/f/a.mov")).toEqual({ make: true, out: "/f/Proxies/a_Proxy.mp4", height: 540, audioChannels: 2 });
    expect(proxyPlan(v(1080, 1920), "/f/a.mov", "/p")).toMatchObject({ make: true, out: "/p/a_Proxy.mp4", height: 960 });
    expect(proxyPlan(v(960, 540), "/f/a.mov").make).toBe(false);
    expect(proxyPlan(v(4000, 3000, { isImage: true }), "/f/a.jpg").make).toBe(false);
    expect(proxyPlan(v(1920, 1080, { hasAudio: false }), "/f/a.mov")).toMatchObject({ audioChannels: undefined });
  });
});

const ff = findTool("ffmpeg");
const gen = (out: string, args: string[]) => execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", ...args, out]);

describe.skipIf(!existsSync(ff))("eyes on real files (fake model)", () => {
  let dir: string;
  let red: string, blue: string, still: string, sound: string;
  beforeAll(() => {
    dir = tmp();
    process.env.EDITZ_HOME = join(dir, "home");
    red = join(dir, "red.mp4");
    blue = join(dir, "blue.mp4");
    still = join(dir, "blue.png");
    sound = join(dir, "tone.wav");
    gen(red, ["-f", "lavfi", "-i", "color=c=0xd2691e:s=320x180:r=25:d=4", "-pix_fmt", "yuv420p"]);
    gen(blue, ["-f", "lavfi", "-i", "color=c=0x1e3a8f:s=320x180:r=25:d=6", "-pix_fmt", "yuv420p"]);
    gen(still, ["-f", "lavfi", "-i", "color=c=0x1e3a8f:s=320x180", "-frames:v", "1"]);
    gen(sound, ["-f", "lavfi", "-i", "sine=f=440:d=2"]);
  });

  /** Fake SigLIP: frames of the red clip point at axis 0, blue at axis 1; texts by keyword. */
  function fakeWorker(idx: MediaIndex, redSum: string) {
    const calls: { method: string; n: number }[] = [];
    const textAxis = (t: string) => {
      if (/orange|cozy|warm/.test(t)) return 0;
      if (/blue|tense|ocean/.test(t)) return 1;
      const m = MOODS.findIndex((x) => t.includes(` ${x} `));
      return m >= 0 ? 2 + m : 2 + MOODS.length + (t.length % (DIM - 2 - MOODS.length));
    };
    const w: WorkerLike = {
      async call<T>(method: string, params?: any): Promise<T> {
        if (method === "embed_images") {
          calls.push({ method, n: params.paths.length });
          return { model: VISION_MODEL, vectors: params.paths.map((p: string) => b64(unit(p.includes(redSum) ? 0 : 1))) } as T;
        }
        if (method === "embed_texts") {
          calls.push({ method, n: params.texts.length });
          return { model: VISION_MODEL, vectors: params.texts.map((t: string) => b64(unit(textAxis(t)))) } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    return { w, calls, idx };
  }

  it("looks once, tags, and finds by content, mood, look and likeness", async () => {
    const idx = new MediaIndex(":memory:");
    const redSum = (await ingest(idx, red)).checksum;
    const { w, calls } = fakeWorker(idx, redSum);

    const r = await visualAnalyze(idx, w, red);
    expect(r.frames).toBeGreaterThan(1);
    expect(r.look?.labels).toContain("warm");
    expect(existsSync(join(process.env.EDITZ_HOME!, "cache", "frames", redSum))).toBe(true);
    expect((await visualAnalyze(idx, w, red)).cached).toBe(true);
    expect(calls.filter((c) => c.method === "embed_images").length).toBe(1);

    for (const f of [blue, still]) await visualAnalyze(idx, w, f);
    expect((await visualAnalyze(idx, w, sound)).skipped).toMatch(/audio/);

    const d = await describeVisual(idx, w, redSum);
    expect(d!.moods[0]!.mood).toBe("cozy");

    const byQuery = await searchMedia(idx, w, { query: "orange" });
    expect(byQuery.searched).toBe(3);
    expect(byQuery.hits[0]!.path).toBe(red);
    expect(byQuery.hits[0]!.at_s).toBeGreaterThan(0);
    expect(byQuery.hits[0]!.frame && existsSync(byQuery.hits[0]!.frame)).toBe(true);

    expect((await searchMedia(idx, w, { mood: "cozy" })).hits[0]!.path).toBe(red);
    expect((await searchMedia(idx, w, { mood: "tense", kind: "video" })).hits[0]!.path).toBe(blue);
    expect((await searchMedia(idx, w, { look: "blue", kind: "image" })).hits.map((h) => h.path)).toEqual([still]);
    expect((await searchMedia(idx, w, { like: blue, kind: "video" })).hits[0]!.path).toBe(blue);
    expect((await searchMedia(idx, w, { query: "ocean", minDurationSec: 5 })).hits.map((h) => h.path)).toEqual([blue]);

    // Text vectors are cached: asking again sends nothing new to the model.
    const before = calls.length;
    await searchMedia(idx, w, { query: "orange", mood: "cozy" });
    expect(calls.length).toBe(before);
    await expect(searchMedia(idx, w, {})).rejects.toThrow(/at least one/);
  });

  it("makes proxies once, keeps channels, skips stills", async () => {
    const big = join(dir, "big.mov");
    gen(big, ["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=25:d=2", "-f", "lavfi", "-i", "sine=f=330:d=2", "-ac", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-shortest"]);
    const idx = new MediaIndex(":memory:");
    const out = join(dir, "px");
    const r = await makeProxies(idx, [big, still], { outDir: out });
    expect(r[0]).toMatchObject({ made: true, proxy: join(out, "big_Proxy.mp4") });
    expect(r[1]!.skipped).toMatch(/still/);
    const p: MediaInfo = await probe(r[0]!.proxy!);
    expect([p.width, p.height, p.audioChannels]).toEqual([960, 540, 2]);
    expect(Math.abs(p.durationSec - 2)).toBeLessThan(0.1);
    const again = await makeProxies(idx, [big], { outDir: out });
    expect(again[0]).toMatchObject({ made: false, skipped: "proxy already there" });
    expect(statSync(r[0]!.proxy!).size).toBeGreaterThan(1000);
  });

  it("raw frames come back at the asked size", async () => {
    const raw = await rawFrames(red, { fps: 2, width: 16, height: 9 });
    expect(raw.frames.length).toBeGreaterThanOrEqual(7);
    expect(raw.frames[0]!.length).toBe(16 * 9 * 3);
  });
});
