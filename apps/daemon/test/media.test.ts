import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertProject, type ProjectInput } from "@editz/ir";
import { keepRanges, silenceCutProject } from "../src/edit/silence-cut.ts";
import { analyze, collectMedia, ingest } from "../src/media/analyze.ts";
import { contactSheet, findTool, parseLoudnorm, parseProbe, parseRate, parseScenes, parseSilence, sampleTimes, type MediaInfo } from "../src/media/ffmpeg.ts";
import { fastChecksum, MediaIndex } from "../src/media/index-db.ts";
import { loudnessIssues, qcProject, qcRender, QC_TARGETS } from "../src/qc.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "editz-m1-"));

describe("ffmpeg output parsers", () => {
  it("parseSilence pairs start/end and closes a trailing silence", () => {
    const err = [
      "[silencedetect @ 0x1] silence_start: 2.002",
      "[silencedetect @ 0x1] silence_end: 3.5 | silence_duration: 1.498",
      "[silencedetect @ 0x1] silence_start: -0.01",
      "[silencedetect @ 0x1] silence_end: 0.4 | silence_duration: 0.4",
      "[silencedetect @ 0x1] silence_start: 9.1",
    ].join("\n");
    expect(parseSilence(err, 10)).toEqual([
      { start: 2.002, end: 3.5 },
      { start: 0, end: 0.4 },
      { start: 9.1, end: 10 },
    ]);
  });

  it("parseLoudnorm reads the last JSON block, -inf as -Infinity", () => {
    const err = `junk {not json\n[Parsed_loudnorm_0 @ 0x2]\n{\n\t"input_i" : "-19.52",\n\t"input_tp" : "-3.10",\n\t"input_lra" : "4.20",\n\t"input_thresh" : "-29.80"\n}\n`;
    expect(parseLoudnorm(err)).toEqual({ integrated: -19.52, truePeak: -3.1, lra: 4.2, threshold: -29.8 });
    expect(parseLoudnorm(`{"input_i":"-inf","input_tp":"-inf","input_lra":"0.00","input_thresh":"-70.00"}`).integrated).toBe(-Infinity);
  });

  it("parseScenes dedups and sorts showinfo pts_time", () => {
    const err = "[Parsed_showinfo_2 @ 0x3] n:   1 pts: 75 pts_time:5.005 duration:1\n[Parsed_showinfo_2 @ 0x3] n:   0 pts: 30 pts_time:2.5 x\n[Parsed_showinfo_2 @ 0x3] n:   2 pts: 75 pts_time:5.005";
    expect(parseScenes(err)).toEqual([2.5, 5.005]);
  });

  it("parseRate snaps sloppy NTSC rates", () => {
    expect(parseRate("30000/1001")).toEqual({ num: 30000, den: 1001 });
    expect(parseRate("2997/100")).toEqual({ num: 30000, den: 1001 });
    expect(parseRate("25/1")).toEqual({ num: 25, den: 1 });
    expect(parseRate("0/0")).toBeUndefined();
  });

  it("parseProbe swaps size for rotated phone video and spots stills", () => {
    const phone = parseProbe("/x/IMG_1.MOV", {
      format: { duration: "12.5", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
      streams: [
        { codec_type: "video", codec_name: "hevc", width: 1920, height: 1080, avg_frame_rate: "30/1", side_data_list: [{ rotation: -90 }] },
        { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" },
      ],
    });
    expect(phone).toMatchObject({ width: 1080, height: 1920, rotation: 270, rate: { num: 30, den: 1 }, hasAudio: true, isImage: false });
    const still = parseProbe("/x/a.png", { format: { format_name: "png_pipe" }, streams: [{ codec_type: "video", codec_name: "png", width: 800, height: 600 }] });
    expect(still).toMatchObject({ isImage: true, durationSec: 0 });
    expect(still.rate).toBeUndefined();
  });

  it("sampleTimes avoids the first and last frame", () => {
    expect(sampleTimes(10, 4)).toEqual([1.25, 3.75, 6.25, 8.75]);
  });
});

describe("silence cut", () => {
  it("keepRanges pads, merges short gaps and drops blips", () => {
    const sil = [
      { start: 0, end: 1 },
      { start: 3, end: 3.2 }, // 0.2 s pause: merged back after padding
      { start: 5, end: 8 },
      { start: 8.3, end: 9.8 }, // leaves a 0.3 s blip at 8.0–8.3 → padded 7.85–8.45, kept (0.6 s)
    ];
    expect(keepRanges(sil, 10, { padSec: 0.15, minKeepSec: 0.4, mergeGapSec: 0.3 })).toEqual([
      { start: 0.85, end: 5.15 },
      { start: 7.85, end: 8.45 },
      { start: 9.65, end: 10 },
    ].filter((r) => r.end - r.start >= 0.4));
  });

  it("silenceCutProject makes a valid, gapless, linked IR", () => {
    const info: MediaInfo = { path: "/x/talk.mov", durationSec: 10, hasVideo: true, hasAudio: true, isImage: false, width: 1920, height: 1080, rate: { num: 25, den: 1 }, audioChannels: 2 };
    const { project, stats } = silenceCutProject(info, [{ start: 1, end: 3 }, { start: 5, end: 6.5 }]);
    const p = assertProject(project);
    const seq = p.sequences[0]!;
    expect(seq.video[0]!.items.map((c) => [c.start, c.end, c.in])).toEqual([[0, 50, 25], [50, 88, 125]]);
    expect(seq.audio[0]!.items.map((c) => [c.start, c.end, c.in])).toEqual([[0, 50, 25], [50, 88, 125]]);
    expect(stats).toMatchObject({ original_s: 10, kept_s: 3.52, pieces: 2 });
    expect(qcProject(p).blocking.filter((i) => i.check !== "offline")).toEqual([]);
  });
});

describe("QC v0", () => {
  const base = (): ProjectInput => ({
    ir_version: 1,
    name: "q",
    media: [{ id: "m", path: "/definitely/missing.mov", kind: "video", duration: 300, has_video: true, has_audio: true }],
    sequences: [
      {
        name: "S",
        rate: { num: 30, den: 1 },
        width: 1920,
        height: 1080,
        video: [{ items: [{ id: "v1", media_id: "m", start: 0, end: 30, in: 0 }, { id: "v2", media_id: "m", start: 45, end: 90, in: 30 }] }],
        audio: [{ items: [{ id: "a1", media_id: "m", start: 0, end: 90, in: 0 }] }],
      },
    ],
  });

  it("flags offline media, picture gaps and wrong format/length", () => {
    const r = qcProject(base(), undefined, QC_TARGETS.shorts);
    expect(r.pass).toBe(false);
    const checks = r.blocking.map((i) => i.check).sort();
    expect(checks).toEqual(["format", "gap", "offline"]);
    expect(r.blocking.find((i) => i.check === "gap")!.at).toBe(1);
  });

  it("loudness rules", () => {
    expect(loudnessIssues({ integrated: -14.4, truePeak: -1.5, lra: 5, threshold: -24 }, QC_TARGETS.youtube!)).toEqual([]);
    const bad = loudnessIssues({ integrated: -20, truePeak: 0.3, lra: 5, threshold: -30 }, QC_TARGETS.youtube!);
    expect(bad.map((i) => i.check)).toEqual(["loudness", "true_peak"]);
    expect(bad[0]!.message).toMatch(/too quiet by 6\.0 LU/);
  });
});

describe("media index", () => {
  it("checksum is content-based and cached by size+mtime", () => {
    const d = tmp();
    const a = join(d, "a.bin");
    const b = join(d, "b.bin");
    const big = Buffer.alloc(9 * 1024 * 1024, 7);
    writeFileSync(a, big);
    writeFileSync(b, big);
    expect(fastChecksum(a)).toBe(fastChecksum(b));
    big[big.length - 1] = 8;
    writeFileSync(b, big);
    expect(fastChecksum(a)).not.toBe(fastChecksum(b));
    const idx = new MediaIndex(":memory:");
    expect(idx.checksumFor(a)).toBe(fastChecksum(a));
    idx.putAnalysis("x", "k/v1", { n: 1 });
    expect(idx.getAnalysis("x", "k/v1")).toEqual({ n: 1 });
    expect(idx.stats()).toEqual({ files: 1, media: 0, analyses: 1 });
  });
});

let hasFfmpeg = false;
try {
  findTool("ffmpeg");
  findTool("ffprobe");
  hasFfmpeg = true;
} catch {}

describe.skipIf(!hasFfmpeg)("real FFmpeg", () => {
  const dir = tmp();
  const clip = join(dir, "talk.mp4");
  const wav = join(dir, "vo.wav");

  beforeAll(() => {
    const ff = findTool("ffmpeg");
    // 7.5 s: red/blue/green 2.5 s each (2 shot cuts); tone with silence at 2–3.5 s and 5.5–6.5 s.
    const tone = "aevalsrc='if(between(t\\,2\\,3.5)+between(t\\,5.5\\,6.5)\\,0\\,0.3*sin(2*PI*440*t))':s=48000:d=7.5";
    execFileSync(ff, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=2.5",
      "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=25:d=2.5",
      "-f", "lavfi", "-i", "color=c=green:s=320x240:r=25:d=2.5",
      "-f", "lavfi", "-i", tone,
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-g", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
    ]);
    execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", tone, wav]);
  });

  it("ingests once, then serves from cache", async () => {
    const idx = new MediaIndex(join(dir, "i.sqlite"));
    const first = await ingest(idx, clip);
    expect(first.cached).toBe(false);
    expect(first.info).toMatchObject({ hasVideo: true, hasAudio: true, width: 320, height: 240, rate: { num: 25, den: 1 } });
    expect(first.info.durationSec).toBeCloseTo(7.5, 1);
    expect((await ingest(idx, clip)).cached).toBe(true);
    expect(collectMedia([dir]).sort()).toEqual([clip, wav].sort());
    idx.close();
  });

  it("finds silence, loudness and shot cuts", async () => {
    const idx = new MediaIndex(":memory:");
    const a = await analyze(idx, clip, ["silence", "loudness", "scenes"], { minSilenceSec: 0.5 });
    expect(a.silence!.length).toBe(2);
    expect(a.silence![0]!.start).toBeCloseTo(2, 1);
    expect(a.silence![0]!.end).toBeCloseTo(3.5, 1);
    expect(a.silence![1]!.start).toBeCloseTo(5.5, 1);
    expect(a.loudness!.integrated).toBeLessThan(-5);
    expect(a.loudness!.integrated).toBeGreaterThan(-30);
    expect(a.scenes!.length).toBe(2);
    expect(a.scenes![0]).toBeCloseTo(2.5, 1);
    expect(a.scenes![1]).toBeCloseTo(5, 1);
    const again = await analyze(idx, clip, ["silence", "loudness", "scenes"], { minSilenceSec: 0.5 });
    expect(again.cached.sort()).toEqual(["loudness", "scenes", "silence"]);
  });

  it("silence cut on a real file removes the two pauses", async () => {
    const idx = new MediaIndex(":memory:");
    const a = await analyze(idx, wav, ["silence"]);
    const keep = keepRanges(a.silence!, a.info.durationSec, { padSec: 0.1 });
    expect(keep.length).toBe(3);
    const { project, stats } = silenceCutProject(a.info, keep);
    const p = assertProject(project);
    expect(p.sequences[0]!.video[0]!.items).toEqual([]);
    expect(stats.removed_s).toBeGreaterThan(1.8);
    expect(stats.removed_s).toBeLessThan(2.5);
    expect(qcProject(p).pass).toBe(true);
  });

  it("makes a contact sheet JPEG", async () => {
    const out = join(dir, "sheet.jpg");
    const s = await contactSheet(clip, 7.5, out, { count: 6, cols: 3, tileWidth: 160 });
    expect(s).toMatchObject({ cols: 3, rows: 2 });
    const jpg = readFileSync(out);
    expect(jpg.subarray(0, 2).toString("hex")).toBe("ffd8");
    const info = await ingest(new MediaIndex(":memory:"), out);
    expect([info.info.width, info.info.height]).toEqual([480, 240]);
  });

  it("QC measures a render", async () => {
    const r = await qcRender(wav, QC_TARGETS.youtube);
    expect(r.metrics.loudness).toBeDefined();
    expect(existsSync(wav)).toBe(true);
    expect(r.pass).toBe(Math.abs(r.metrics.loudness!.integrated + 14) <= 1 && r.metrics.loudness!.truePeak <= -1);
  });
});
