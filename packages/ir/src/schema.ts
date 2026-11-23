import { z } from "zod";

/**
 * Editz Timeline IR v1.
 * All timeline times are integer frames in the SEQUENCE timebase.
 * Media durations are stored in the same timebase so every compiler shares one clock.
 */

export const Rate = z.object({
  /** Frames per second as a fraction, e.g. 30000/1001 for 29.97. */
  num: z.number().int().positive(),
  den: z.number().int().positive(),
});
export type Rate = z.infer<typeof Rate>;

export const MediaKind = z.enum(["video", "audio", "image", "graphic", "other"]);
export type MediaKind = z.infer<typeof MediaKind>;

export const License = z.object({
  source: z.string(),
  url: z.string().optional(),
  author: z.string().optional(),
  license: z.string(),
  attribution: z.string().optional(),
  commercial_ok: z.boolean(),
});
export type License = z.infer<typeof License>;

export const MediaRef = z.object({
  id: z.string().min(1),
  /** Absolute file path on disk. */
  path: z.string().min(1),
  kind: MediaKind,
  /** Length in sequence frames. Images use a nominal still length. */
  duration: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  has_video: z.boolean(),
  has_audio: z.boolean(),
  audio_channels: z.number().int().min(1).max(32).default(2),
  /** Bin path, e.g. "02 B-ROLL/Stock". */
  bin: z.string().default("99 UNSORTED"),
  license: License.optional(),
});
export type MediaRef = z.infer<typeof MediaRef>;

export const ClipItem = z
  .object({
    id: z.string().min(1),
    media_id: z.string().min(1),
    /** Record (timeline) in/out, frames, out exclusive. */
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    /** Source in point, frames. Source out = in + (end - start). */
    in: z.number().int().nonnegative(),
    enabled: z.boolean().default(true),
    name: z.string().optional(),
  })
  .refine((c) => c.end > c.start, { message: "clip end must be after start" });
export type ClipItem = z.infer<typeof ClipItem>;

export const Track = z.object({
  name: z.string().optional(),
  items: z.array(ClipItem),
});
export type Track = z.infer<typeof Track>;

export const MarkerColor = z.enum(["green", "red", "purple", "orange", "yellow", "white", "blue", "cyan"]);

export const Marker = z.object({
  frame: z.number().int().nonnegative(),
  duration: z.number().int().nonnegative().default(0),
  name: z.string().default(""),
  comment: z.string().default(""),
  color: MarkerColor.default("green"),
});
export type Marker = z.infer<typeof Marker>;

export const Sequence = z.object({
  name: z.string().min(1),
  rate: Rate,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  audio_rate: z.number().int().positive().default(48000),
  video: z.array(Track).min(1),
  audio: z.array(Track).default([]),
  markers: z.array(Marker).default([]),
});
export type Sequence = z.infer<typeof Sequence>;

export const UsageMode = z.enum(["commercial", "personal"]);

export const Project = z.object({
  ir_version: z.literal(1),
  name: z.string().min(1),
  usage_mode: UsageMode.default("commercial"),
  bins: z.array(z.string()).default([]),
  media: z.array(MediaRef),
  sequences: z.array(Sequence),
});
export type Project = z.infer<typeof Project>;
export type ProjectInput = z.input<typeof Project>;
