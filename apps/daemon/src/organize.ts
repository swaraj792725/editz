import { readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

/**
 * organize_project v0: filename + extension rules only (PRD §11.3 signals that
 * need audio/vision analysis come in M1). Low confidence → 99 UNSORTED so a
 * zero-skill user is never shown a confident wrong answer.
 */

export const BINS = {
  aroll: "01 A-ROLL",
  broll: "02 B-ROLL",
  music: "03 MUSIC",
  vo: "04 VOICE-OVER",
  sfx: "05 SFX",
  graphics: "06 GRAPHICS",
  stills: "07 STILLS",
  refs: "08 REFERENCES",
  sequences: "09 SEQUENCES",
  unsorted: "99 UNSORTED",
} as const;

export interface Classified {
  path: string;
  bin: string;
  confidence: number;
  reason: string;
}

const VIDEO = new Set([".mp4", ".mov", ".mxf", ".m4v", ".avi", ".mkv", ".mts", ".m2ts", ".r3d", ".braw", ".webm", ".mpg", ".mpeg"]);
const AUDIO = new Set([".wav", ".mp3", ".aif", ".aiff", ".m4a", ".aac", ".flac", ".ogg", ".bwf"]);
const STILL = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".heic", ".webp", ".dng", ".cr2", ".cr3", ".nef", ".arw", ".bmp", ".gif"]);
const GRAPHIC = new Set([".psd", ".ai", ".svg", ".eps", ".mogrt", ".aep", ".cube", ".look"]);
const REF = new Set([".pdf", ".txt", ".md", ".docx", ".doc", ".rtf", ".srt", ".vtt", ".csv"]);
/** Files FFmpeg can analyse (video, audio, stills). */
export const MEDIA_EXTS = new Set([...VIDEO, ...AUDIO, ...STILL]);
const SKIP = new Set([".prproj", ".prel", ".pek", ".cfa", ".ims", ".xmp", ".lrv", ".thm", ".ds_store", ".db", ".tmp", ".part"]);

// Word-ish boundaries so "vo" doesn't match "volcano"; "_" and "-" count as separators.
const has = (name: string, words: string[]) => new RegExp(`(^|[^a-z0-9])(${words.join("|")})([^a-z0-9]|$)`, "i").test(name);

/** `rel` = path relative to the scanned root, so the root's own folder names don't leak in. */
export function classify(path: string, rel = basename(path)): Classified | null {
  const ext = extname(path).toLowerCase();
  const name = basename(path).toLowerCase();
  // Look at parent folders too: "Footage/B-Roll/x.mp4".
  const ctx = rel.toLowerCase().replace(/\\/g, "/");
  const r = (bin: string, confidence: number, reason: string): Classified => ({ path, bin, confidence, reason });
  if (SKIP.has(ext) || name.startsWith(".")) return null;

  if (VIDEO.has(ext)) {
    if (has(ctx, ["broll", "b-roll", "b_roll", "cutaway", "cutaways", "stock", "pexels", "pixabay", "coverr", "mixkit", "drone", "timelapse", "generated"]))
      return r(BINS.broll, 0.85, "video named or filed as b-roll/stock");
    if (has(ctx, ["aroll", "a-roll", "a_roll", "interview", "talking", "presenter", "podcast", "camera ?a", "cam ?a", "host"]))
      return r(BINS.aroll, 0.8, "video named or filed as interview/A-roll");
    if (has(ctx, ["ref", "reference", "inspo", "moodboard"])) return r(BINS.refs, 0.7, "video filed as reference");
    return r(BINS.unsorted, 0.3, "video; A/B-roll needs speech detection (M1)");
  }
  if (AUDIO.has(ext)) {
    if (has(ctx, ["sfx", "fx", "whoosh", "swoosh", "hit", "impact", "riser", "foley", "ambience", "ambient", "click", "transition", "boom"]))
      return r(BINS.sfx, 0.85, "audio named as sound effect");
    if (has(ctx, ["vo", "voiceover", "voice-over", "voice_over", "voice", "narration", "narrator", "tts", "script"]))
      return r(BINS.vo, 0.85, "audio named as voice-over");
    if (has(ctx, ["music", "song", "track", "bed", "bgm", "score", "beat", "instrumental", "theme"]))
      return r(BINS.music, 0.85, "audio named as music");
    return r(BINS.unsorted, 0.3, "audio; music/VO/SFX needs audio analysis (M1)");
  }
  if (GRAPHIC.has(ext)) return r(BINS.graphics, 0.9, `graphic file (${ext})`);
  if (STILL.has(ext)) {
    if (has(ctx, ["logo", "title", "lower ?third", "overlay", "icon"])) return r(BINS.graphics, 0.75, "image named as graphic");
    if (has(ctx, ["ref", "reference", "inspo", "moodboard", "screenshot"])) return r(BINS.refs, 0.7, "image filed as reference");
    return r(BINS.stills, 0.8, "still image");
  }
  if (REF.has(ext)) return r(BINS.refs, 0.8, `document (${ext})`);
  return r(BINS.unsorted, 0.1, `unknown type ${ext || "(none)"}`);
}

export interface OrganizePlan {
  root: string;
  items: Classified[];
  byBin: Record<string, string[]>;
  skipped: number;
}

export function scanFolder(root: string, maxFiles = 20000): OrganizePlan {
  const items: Classified[] = [];
  let skipped = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (items.length >= maxFiles) return;
      if (name.startsWith(".")) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        skipped++;
        continue;
      }
      // .app/.fcpbundle style packages and Premiere cache folders are not media.
      if (st.isDirectory()) {
        if (/\.(app|fcpbundle|photoslibrary)$/i.test(name) || /^(Adobe Premiere Pro (Auto-Save|Video Previews|Audio Previews)|Media Cache( Files)?)$/i.test(name)) continue;
        walk(p);
      } else {
        const c = classify(p, relative(root, p));
        if (c) items.push(c);
        else skipped++;
      }
    }
  };
  walk(root);
  const byBin: Record<string, string[]> = {};
  for (const it of items) (byBin[it.bin] ??= []).push(it.path);
  return { root, items, byBin, skipped };
}
