import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertProject } from "@editz/ir";
import { dbToGain, projectToFcp7Xml } from "@editz/compilers";
import { twentyClipProject } from "../../../packages/ir/test/fixtures.ts";
import { buildCues, captionIssues, splitLines, toSrt, toVtt } from "../src/speech/captions.ts";
import { findFillers, mergeRanges, subtractRanges, tidyWords, wordsOnTimeline, type Word } from "../src/speech/transcript.ts";
import { fillerCutPlan, langForVoice } from "../src/speech/service.ts";
import { activeSpans, applyDucking, duckKeys, musicTracks } from "../src/edit/mix.ts";
import { paragraphs, placeVoiceover } from "../src/edit/voiceover.ts";
import { PyWorker, WorkerError, defaultWorkerCommand } from "../src/worker.ts";
import { qcCaptions } from "../src/qc.ts";
import type { MediaInfo } from "../src/media/ffmpeg.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "editz-s2-"));

/** Real Whisper turbo output for the test sentence (scratch recording). */
const TALK: Word[] = (
  [
    ["Hi", 0.0, 0.2], ["everyone.", 0.2, 0.64], ["Um,", 1.0, 1.32], ["so", 1.54, 1.84], ["today", 1.84, 2.16], ["I", 2.16, 2.36],
    ["want", 2.36, 2.6], ["to", 2.6, 2.76], ["show", 2.76, 2.96], ["you,", 2.96, 3.24], ["uh,", 3.38, 3.74], ["how", 3.94, 4.18],
    ["we", 4.18, 4.34], ["make", 4.34, 4.58], ["coffee", 4.58, 4.94], ["at", 4.94, 5.1], ["our", 5.1, 5.24], ["cafe.", 5.24, 5.62],
    ["We", 6.04, 6.16], ["we", 6.16, 6.3], ["start", 6.3, 6.6], ["with", 6.6, 6.82], ["fresh", 6.82, 7.14], ["beans.", 7.14, 7.62],
    ["Then,", 7.88, 8.2], ["um,", 8.4, 8.72], ["we", 8.94, 9.14], ["grind", 9.14, 9.42], ["them", 9.42, 9.58], ["right", 9.58, 9.8],
    ["before", 9.8, 10.18], ["brewing.", 10.18, 10.52],
  ] as const
).map(([text, start, end]) => ({ text, start, end }));

const info: MediaInfo = { path: "/x/talk.wav", durationSec: 11, hasVideo: false, hasAudio: true, isImage: false, audioChannels: 1 } as MediaInfo;

describe("fillers", () => {
  it("finds um/uh and the stutter, never cutting into neighbours", () => {
    const hits = findFillers(TALK);
    expect(hits.map((h) => [h.text, h.kind])).toEqual([
      ["Um,", "filler"],
      ["uh,", "filler"],
      ["We", "repeat"],
      ["um,", "filler"],
    ]);
    for (const h of hits) {
      const before = TALK.filter((w) => w.end <= h.start + 1e-9);
      const after = TALK.filter((w) => w.start >= h.end - 1e-9);
      expect(before.length + after.length + h.text.split(" ").length).toBe(TALK.length);
    }
  });

  it("keeps meaningful doubles and soft words unless aggressive", () => {
    const w = (t: string, i: number): Word => ({ text: t, start: i * 0.3, end: i * 0.3 + 0.25 });
    expect(findFillers(["I", "had", "had", "enough."].map(w))).toEqual([]);
    const soft = ["So,", "like,", "we", "went,", "you", "know,", "home."].map(w);
    expect(findFillers(soft)).toEqual([]);
    expect(findFillers(soft, { aggressive: true }).map((h) => h.text)).toEqual(["So,", "like,", "you know,"]);
  });

  it("range maths", () => {
    expect(mergeRanges([{ start: 2, end: 3 }, { start: 0, end: 1 }, { start: 0.9, end: 1.5 }])).toEqual([
      { start: 0, end: 1.5 },
      { start: 2, end: 3 },
    ]);
    expect(subtractRanges([{ start: 0, end: 10 }], [{ start: 2, end: 3 }, { start: 3.05, end: 4 }])).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 10 },
    ]);
  });

  it("tidyWords capitalises a new sentence start", () => {
    expect(tidyWords([{ text: "done.", start: 0, end: 1 }, { text: "so", start: 1, end: 2 }]).map((w) => w.text)).toEqual(["Done.", "So"]);
  });
});

describe("filler cut plan", () => {
  const plan = fillerCutPlan(info, TALK, { sequence: "Talk - tight" });

  it("builds a valid tight cut without the fillers", () => {
    expect(plan.stats.fillers_removed).toBe(4);
    expect(plan.stats.kept_s).toBeLessThan(11 - 1.2);
    expect(plan.project.sequences[0]!.name).toBe("Talk - tight");
    const text = plan.words.map((w) => w.text).join(" ");
    expect(text).toBe("Hi everyone. So today I want to show you, how we make coffee at our cafe. We start with fresh beans. Then, we grind them right before brewing.");
  });

  it("timeline words are ordered and inside the sequence", () => {
    const seq = plan.project.sequences[0]!;
    const end = Math.max(...seq.audio[0]!.items.map((c) => c.end)) / (seq.rate.num / seq.rate.den);
    for (let i = 1; i < plan.words.length; i++) expect(plan.words[i]!.start).toBeGreaterThanOrEqual(plan.words[i - 1]!.start);
    expect(plan.words.at(-1)!.end).toBeLessThanOrEqual(end + 1e-6);
  });

  it("captions pass QC", () => {
    expect(plan.cues.length).toBeGreaterThan(1);
    expect(qcCaptions(plan.cues).pass).toBe(true);
  });
});

describe("wordsOnTimeline", () => {
  it("maps source words through clip in/out to record time and drops cut words", () => {
    const p = assertProject({
      ir_version: 1,
      name: "t",
      media: [{ id: "src", path: "/x.wav", kind: "audio", duration: 300, has_video: false, has_audio: true }],
      sequences: [{ name: "s", rate: { num: 10, den: 1 }, width: 1920, height: 1080, video: [{ items: [] }], audio: [{ items: [{ id: "c1", media_id: "src", start: 0, end: 10, in: 20 }] }] }],
    });
    const words = [
      { text: "gone", start: 0.5, end: 1.0 },
      { text: "kept", start: 2.2, end: 2.6 },
      { text: "edge", start: 2.9, end: 3.05 },
    ];
    expect(wordsOnTimeline(p, p.sequences[0]!, new Map([["src", words]]))).toEqual([
      { text: "kept", start: 0.2, end: 0.6 },
      { text: "edge", start: 0.9, end: 1 },
    ]);
  });
});

describe("captions", () => {
  it("splitLines balances and prefers punctuation", () => {
    expect(splitLines("short")).toEqual(["short"]);
    const l = splitLines("Today I want to show you, how we make coffee at our cafe")!;
    expect(l).toHaveLength(2);
    expect(l[0]).toBe("Today I want to show you,");
    expect(splitLines("x".repeat(100))).toBeNull();
  });

  it("long speech → readable cues", () => {
    const words: Word[] = [];
    let t = 0;
    for (let i = 0; i < 120; i++) {
      const text = i % 15 === 14 ? "sentence." : ["the", "quick", "brown", "fox", "jumps"][i % 5]!;
      words.push({ text, start: t, end: t + 0.25 });
      t += i % 30 === 29 ? 1.2 : 0.3;
    }
    const cues = buildCues(words);
    expect(captionIssues(cues).filter((i) => i.blocking)).toEqual([]);
    for (const c of cues) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      expect(c.end - c.start).toBeLessThanOrEqual(7);
    }
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
  });

  it("flags bad cues", () => {
    const bad = [
      { start: 0, end: 0.3, lines: ["a", "b", "c"] },
      { start: 0.2, end: 1, lines: ["y".repeat(50)] },
    ];
    const msgs = captionIssues(bad).map((i) => `${i.blocking ? "B" : "W"}:${i.message}`);
    expect(msgs.some((m) => m.startsWith("B:3 lines"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("B:overlaps"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("B:line of 50"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("W:fast"))).toBe(true);
  });

  it("SRT and VTT stamps", () => {
    const cues = [{ start: 3661.5, end: 3663.25, lines: ["Hello", "there"] }];
    expect(toSrt(cues)).toBe("1\n01:01:01,500 --> 01:01:03,250\nHello\nthere\n");
    expect(toVtt(cues)).toBe("WEBVTT\n\n01:01:01.500 --> 01:01:03.250\nHello\nthere\n");
  });
});

describe("ducking", () => {
  it("activeSpans merges across short gaps", () => {
    const seq = assertProject(twentyClipProject()).sequences[0]!;
    expect(activeSpans(seq, [2], 0)).toHaveLength(3);
    expect(activeSpans(seq, [2], 400)).toHaveLength(1);
  });

  it("duckKeys ramps down and up within the clip", () => {
    const keys = duckKeys({ start: 0, end: 1000 }, [{ start: 100, end: 300 }], -15, 10, 20)!;
    expect(keys).toEqual([
      { frame: 0, db: 0 },
      { frame: 90, db: 0 },
      { frame: 100, db: -15 },
      { frame: 300, db: -15 },
      { frame: 320, db: 0 },
      { frame: 1000, db: 0 },
    ]);
    expect(duckKeys({ start: 0, end: 50 }, [{ start: 100, end: 300 }], -15, 10, 20)).toBeUndefined();
  });

  it("a clip starting mid-duck starts low", () => {
    const keys = duckKeys({ start: 200, end: 1000 }, [{ start: 100, end: 300 }], -12, 10, 20)!;
    expect(keys[0]).toEqual({ frame: 0, db: -12 });
  });

  it("applyDucking puts keyframes on music only, valid IR, emitted as Audio Levels", () => {
    const p = assertProject(twentyClipProject());
    expect(musicTracks(p, p.sequences[0]!)).toEqual([1]);
    const r = applyDucking(p, undefined, [2], [1]);
    expect(r.ducked).toBe(1);
    const out = assertProject(r.project);
    const music = out.sequences[0]!.audio[1]!.items[0]!;
    expect(music.levels!.some((k) => k.db === -15)).toBe(true);
    const xml = projectToFcp7Xml(out);
    expect(xml).toContain("<effectid>audiolevels</effectid>");
    expect(xml).toContain(`<value>${dbToGain(-15)}</value>`);
  });

  it("dbToGain", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(dbToGain(20)).toBeCloseTo(3.98109, 4);
  });
});

describe("voice-over placement", () => {
  it("splits a script into paragraphs", () => {
    expect(paragraphs("One\nline.\n\nTwo.")).toEqual(["One line.", "Two."]);
    expect(paragraphs("A\nB")).toEqual(["A", "B"]);
  });

  it("reuses the VO-only track, ducks music, stays valid", () => {
    const p = assertProject(twentyClipProject());
    const r = placeVoiceover(p, undefined, [{ path: "/vo/1.wav", durationSec: 2 }, { path: "/vo/2.wav", durationSec: 1.5 }], { startSec: 60 });
    expect(r.track).toBe(2);
    expect(r.placed).toHaveLength(2);
    expect(r.placed[1]!.start_s).toBeGreaterThan(r.placed[0]!.end_s);
    expect(r.ducked_tracks).toEqual([1]);
    const out = assertProject(r.project);
    expect(out.media.filter((m) => m.bin === "04 VOICE-OVER")).toHaveLength(5);
  });

  it("uses an empty A2, else a new VO track", () => {
    const base = assertProject(twentyClipProject());
    const noVo = { ...base, sequences: [{ ...base.sequences[0]!, audio: [base.sequences[0]!.audio[0]!] }] };
    expect(placeVoiceover(noVo, undefined, [{ path: "/v.wav", durationSec: 1 }]).track).toBe(1);
    const busy = { ...base, sequences: [{ ...base.sequences[0]!, audio: base.sequences[0]!.audio.slice(0, 2) }] };
    const r = placeVoiceover(busy, undefined, [{ path: "/v.wav", durationSec: 1 }]);
    expect(r.track).toBe(2);
    expect(r.project.sequences[0]!.audio[2]!.name).toBe("VO");
  });

  it("refuses to overlap existing VO", () => {
    const p = assertProject(twentyClipProject());
    expect(() => placeVoiceover(p, undefined, [{ path: "/v.wav", durationSec: 5, atSec: 3 }])).toThrow(/overlap/);
  });

  it("voice → language", () => {
    expect(langForVoice("af_heart")).toBe("en-us");
    expect(langForVoice("bm_george")).toBe("en-gb");
    expect(langForVoice("jf_alpha")).toBe("ja");
  });
});

describe("PyWorker protocol", () => {
  const fake = () => {
    const dir = tmp();
    const f = join(dir, "fake.mjs");
    writeFileSync(
      f,
      `import { createInterface } from "node:readline";
console.log("noise before ready");
console.log(JSON.stringify({ event: "ready", version: "t", methods: ["echo"] }));
createInterface({ input: process.stdin }).on("line", (l) => {
  const r = JSON.parse(l);
  if (r.method === "echo") {
    console.log(JSON.stringify({ id: r.id, event: "progress", message: "half", value: 0.5 }));
    console.log(JSON.stringify({ id: r.id, result: r.params }));
  } else if (r.method === "die") { console.error("boom"); process.exit(3); }
  else if (r.method === "hang") {}
  else console.log(JSON.stringify({ id: r.id, error: { message: "unknown method", kind: "ValueError" } }));
});`,
    );
    return new PyWorker(() => ({ command: process.execPath, args: [f] }), { idleMs: 60_000 });
  };

  it("calls, streams progress, reports errors", async () => {
    const w = fake();
    const seen: number[] = [];
    expect(await w.call("echo", { a: 1 }, { onProgress: (_m, v) => seen.push(v!) })).toEqual({ a: 1 });
    expect(seen).toEqual([0.5]);
    await expect(w.call("nope")).rejects.toMatchObject({ kind: "ValueError" });
    const all = await Promise.all([w.call("echo", { n: 1 }), w.call("echo", { n: 2 })]);
    expect(all).toEqual([{ n: 1 }, { n: 2 }]);
    w.stop();
  });

  it("a crash rejects pending calls with stderr, and the next call restarts", async () => {
    const w = fake();
    const err = (await w.call("die").catch((e: unknown) => e)) as WorkerError;
    expect(err).toBeInstanceOf(WorkerError);
    expect(err.message).toContain("boom");
    expect(await w.call("echo", { again: true })).toEqual({ again: true });
    w.stop();
  });

  it("times out and kills a stuck call", async () => {
    const w = fake();
    await expect(w.call("hang", {}, { timeoutMs: 200 })).rejects.toMatchObject({ kind: "Timeout" });
    expect(w.running).toBe(false);
  });
});

// Real models: EDITZ_REAL_WORKER=1 EDITZ_TALK=/path/talk.wav npx vitest run apps/daemon/test/speech.test.ts
const real = process.env.EDITZ_REAL_WORKER === "1" && process.env.EDITZ_TALK && existsSync(process.env.EDITZ_TALK);
describe.skipIf(!real)("real worker (Whisper + Kokoro)", () => {
  it("transcribes with fillers and speaks", async () => {
    const w = new PyWorker(defaultWorkerCommand);
    try {
      const t = await w.call<{ words: Word[] }>("transcribe", { path: process.env.EDITZ_TALK });
      expect(findFillers(t.words).length).toBeGreaterThan(0);
      const out = join(tmp(), "vo.wav");
      const r = await w.call<{ duration: number }>("tts", { text: "Testing one two.", out });
      expect(r.duration).toBeGreaterThan(0.5);
      expect(readFileSync(out).subarray(0, 4).toString()).toBe("RIFF");
    } finally {
      w.stop();
    }
  }, 600_000);
});
