import type { ProjectInput } from "../src/schema.ts";

/**
 * Golden "20-clip" project used by M0 exit criteria:
 * V1: 10 A-roll clips (linked audio on A1), V2: 6 B-roll, A2: 1 music bed, A3: 3 VO = 20 timeline clips.
 * mediaRoot lets the live test point at real generated media.
 */
export function twentyClipProject(mediaRoot = "/Users/Shared/Editz Golden/media"): ProjectInput {
  const p = (f: string) => `${mediaRoot}/${f}`;
  const media: ProjectInput["media"] = [];
  for (let i = 1; i <= 5; i++) {
    media.push({ id: `a${i}`, path: p(`aroll_0${i}.mp4`), kind: "video", duration: 3600, width: 1920, height: 1080, has_video: true, has_audio: true, bin: "01 A-ROLL" });
  }
  for (let i = 1; i <= 6; i++) {
    media.push({ id: `b${i}`, path: p(`broll_0${i}.mp4`), kind: "video", duration: 600, width: 1920, height: 1080, has_video: true, has_audio: false, bin: "02 B-ROLL/Own" });
  }
  media.push({ id: "m1", path: p("music_bed.wav"), kind: "audio", duration: 9000, has_video: false, has_audio: true, bin: "03 MUSIC" });
  for (let i = 1; i <= 3; i++) {
    media.push({ id: `vo${i}`, path: p(`vo_0${i}.wav`), kind: "audio", duration: 300, has_video: false, has_audio: true, bin: "04 VOICE-OVER" });
  }

  // 10 A-roll segments, back to back, 150 frames each, two per A-roll file.
  const v1: { id: string; media_id: string; start: number; end: number; in: number }[] = [];
  const a1: typeof v1 = [];
  let t = 0;
  for (let i = 0; i < 10; i++) {
    const mediaId = `a${(i % 5) + 1}`;
    const len = 150 + (i % 3) * 30;
    const src = 300 + Math.floor(i / 5) * 900;
    v1.push({ id: `v1c${i + 1}`, media_id: mediaId, start: t, end: t + len, in: src });
    a1.push({ id: `a1c${i + 1}`, media_id: mediaId, start: t, end: t + len, in: src });
    t += len;
  }
  const total = t;
  // 6 B-roll cutaways on V2.
  const v2 = Array.from({ length: 6 }, (_, i) => {
    const start = 60 + i * 290;
    return { id: `v2c${i + 1}`, media_id: `b${i + 1}`, start, end: start + 90, in: 24 * (i + 1) };
  });
  const vo = Array.from({ length: 3 }, (_, i) => {
    const start = 100 + i * 600;
    return { id: `a3c${i + 1}`, media_id: `vo${i + 1}`, start, end: start + 240, in: 0 };
  });

  return {
    ir_version: 1,
    name: "Golden 20",
    usage_mode: "commercial",
    bins: ["01 A-ROLL", "02 B-ROLL/Own", "03 MUSIC", "04 VOICE-OVER", "09 SEQUENCES"],
    media,
    sequences: [
      {
        name: "Golden 20 - Main",
        rate: { num: 30000, den: 1001 },
        width: 1920,
        height: 1080,
        video: [{ items: v1 }, { items: v2 }],
        audio: [{ items: a1 }, { items: [{ id: "a2c1", media_id: "m1", start: 0, end: total, in: 0 }] }, { items: vo }],
        markers: [
          { frame: 0, name: "Hook", comment: "Opening line" },
          { frame: 900, name: "Middle", comment: "" },
          { frame: total - 30, name: "CTA", comment: "Call to action" },
        ],
      },
    ],
  };
}
