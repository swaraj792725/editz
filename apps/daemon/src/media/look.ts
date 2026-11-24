import type { RawFrames } from "./ffmpeg.ts";

/**
 * Look profile: how a clip looks and moves, from tiny RGB frames. No AI model, pure maths.
 * Used for "warm / moody blue / dark" search, colour matching stock to A-roll (S4), and pacing.
 */
export interface LookProfile {
  /** Mean luma 0..1. */
  brightness: number;
  /** Luma standard deviation 0..1. */
  contrast: number;
  /** Mean chroma 0..1 (0 = grey). */
  saturation: number;
  /** Mean (R − B) −1..1: > 0 warm, < 0 cool. */
  warmth: number;
  /** Mean colour in CIE Lab. */
  lab: [number, number, number];
  /** Dominant colours, biggest first. */
  palette: { hex: string; share: number; lab: [number, number, number] }[];
  /** Mean frame-to-frame change inside shots 0..1. */
  motion: number;
  /** Shot cuts per minute (needs scene cuts). */
  cutsPerMin?: number;
  /** Plain words for the numbers. */
  labels: string[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ───────────────────────── colour maths ─────────────────────────

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const LIN = Float64Array.from({ length: 256 }, (_, i) => lin(i));

/** sRGB 0..255 → CIE Lab (D65). */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN[r]!, G = LIN[g]!, B = LIN[b]!;
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToHex([L, a, b]: [number, number, number]): string {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const toS = (v: number) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  const R = toS(3.2406 * X - 1.5372 * Y - 0.4986 * Z);
  const G = toS(-0.9689 * X + 1.8758 * Y + 0.0415 * Z);
  const B = toS(0.0557 * X - 0.204 * Y + 1.057 * Z);
  return "#" + [R, G, B].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function hexToLab(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a hex colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return rgbToLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

const dE = (p: number[], q: number[]) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);

/** Pure: k-means in Lab with a deterministic farthest-point start. */
export function kmeans(points: [number, number, number][], k: number, iters = 12): { center: [number, number, number]; share: number }[] {
  if (!points.length) return [];
  k = Math.min(k, points.length);
  const mean = (ps: [number, number, number][]): [number, number, number] => {
    const s = [0, 0, 0];
    for (const p of ps) for (let i = 0; i < 3; i++) s[i]! += p[i]!;
    return s.map((v) => v / ps.length) as [number, number, number];
  };
  const centers: [number, number, number][] = [mean(points)];
  const near = points.map((p) => dE(p, centers[0]!));
  while (centers.length < k) {
    let best = 0;
    for (let i = 1; i < points.length; i++) if (near[i]! > near[best]!) best = i;
    centers.push([...points[best]!] as [number, number, number]);
    for (let i = 0; i < points.length; i++) near[i] = Math.min(near[i]!, dE(points[i]!, centers[centers.length - 1]!));
  }
  let assign = new Int32Array(points.length);
  for (let it = 0; it < iters; it++) {
    const next = new Int32Array(points.length);
    for (let i = 0; i < points.length; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = dE(points[i]!, centers[c]!);
        if (d < bd) (bd = d), (bi = c);
      }
      next[i] = bi;
    }
    for (let c = 0; c < centers.length; c++) {
      const mine = points.filter((_, i) => next[i] === c);
      if (mine.length) centers[c] = mean(mine);
    }
    const same = next.every((v, i) => v === assign[i]);
    assign = next;
    if (same && it > 0) break;
  }
  const counts = new Array(centers.length).fill(0);
  for (const a of assign) counts[a]++;
  return centers.map((center, c) => ({ center, share: counts[c] / points.length })).filter((c) => c.share > 0).sort((a, b) => b.share - a.share);
}

// ───────────────────────── profile ─────────────────────────

/** Pure: frames (+ shot cuts) → look profile. */
export function lookProfile(raw: RawFrames, scenes?: number[], durationSec?: number): LookProfile {
  const { frames, fps } = raw;
  let n = 0, sumY = 0, sumY2 = 0, sumC = 0, sumW = 0;
  const L = [0, 0, 0];
  const pts: [number, number, number][] = [];
  const pixels = frames.length ? frames[0]!.length / 3 : 0;
  // ≤ ~6000 points for k-means, spread over frames and pixels.
  const step = Math.max(1, Math.floor((frames.length * pixels) / 6000));
  let k = 0;
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 3, k++) {
      const r = f[i]!, g = f[i + 1]!, b = f[i + 2]!;
      const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      sumY += y;
      sumY2 += y * y;
      sumC += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      sumW += (r - b) / 255;
      n++;
      if (k % step === 0) {
        const lab = rgbToLab(r, g, b);
        pts.push(lab);
        for (let j = 0; j < 3; j++) L[j]! += lab[j]!;
      }
    }
  }
  const brightness = n ? sumY / n : 0;
  const contrast = n ? Math.sqrt(Math.max(0, sumY2 / n - brightness ** 2)) : 0;
  const saturation = n ? sumC / n : 0;
  const warmth = n ? sumW / n : 0;
  const lab = (pts.length ? L.map((v) => v / pts.length) : [0, 0, 0]) as [number, number, number];
  const palette = kmeans(pts, 5)
    .filter((c) => c.share >= 0.03)
    .map((c) => ({ hex: labToHex(c.center), share: r3(c.share), lab: c.center.map((v) => Math.round(v * 10) / 10) as [number, number, number] }));

  // Motion: mean absolute luma change between neighbouring frames, skipping pairs that straddle a cut.
  const cuts = scenes ?? [];
  let diffs = 0, pairs = 0;
  for (let i = 1; i < frames.length; i++) {
    const t0 = (i - 1) / fps, t1 = i / fps;
    if (cuts.some((c) => c > t0 && c <= t1)) continue;
    const a = frames[i - 1]!, b = frames[i]!;
    let d = 0;
    for (let j = 0; j < a.length; j += 3) {
      d += Math.abs(0.2126 * (a[j]! - b[j]!) + 0.7152 * (a[j + 1]! - b[j + 1]!) + 0.0722 * (a[j + 2]! - b[j + 2]!));
    }
    diffs += d / (a.length / 3) / 255;
    pairs++;
  }
  // Normalise to change per half-second, so the number doesn't depend on the sample rate.
  const motion = pairs ? (diffs / pairs) * Math.min(1, fps / 2) : 0;
  const cutsPerMin = scenes && durationSec && durationSec > 0 ? (scenes.length / durationSec) * 60 : undefined;

  const p: LookProfile = {
    brightness: r3(brightness),
    contrast: r3(contrast),
    saturation: r3(saturation),
    warmth: r3(warmth),
    lab: lab.map((v) => Math.round(v * 10) / 10) as [number, number, number],
    palette,
    motion: r3(motion),
    cutsPerMin: cutsPerMin === undefined ? undefined : Math.round(cutsPerMin * 10) / 10,
    labels: [],
  };
  p.labels = lookLabels(p, frames.length > 1);
  return p;
}

/** Pure: words for a profile ("dark", "warm", "muted", "slow"...). */
export function lookLabels(p: Omit<LookProfile, "labels">, moving = true): string[] {
  const out: string[] = [];
  if (p.brightness < 0.22) out.push("dark");
  else if (p.brightness > 0.62) out.push("bright");
  if (p.contrast > 0.26) out.push("high contrast");
  else if (p.contrast < 0.1) out.push("flat");
  if (p.warmth > 0.07) out.push("warm");
  else if (p.warmth < -0.04) out.push("cool");
  if (p.saturation < 0.12) out.push(p.saturation < 0.04 ? "black and white" : "muted");
  else if (p.saturation > 0.35) out.push("vivid");
  if (moving) {
    if (p.motion < 0.008) out.push("static");
    else if (p.motion < 0.03) out.push("slow");
    else if (p.motion > 0.07) out.push("fast");
  }
  if (p.cutsPerMin !== undefined && p.cutsPerMin >= 20) out.push("quick cuts");
  return out;
}

// ───────────────────────── matching ─────────────────────────

type PaletteLike = { lab: [number, number, number]; share: number }[];

/** Pure: symmetric share-weighted nearest-colour distance between palettes (ΔE, lower = closer). */
export function paletteDistance(a: PaletteLike, b: PaletteLike): number {
  if (!a.length || !b.length) return 100;
  const one = (x: PaletteLike, y: PaletteLike) => {
    const w = x.reduce((s, c) => s + c.share, 0) || 1;
    return x.reduce((s, c) => s + c.share * Math.min(...y.map((d) => dE(c.lab, d.lab))), 0) / w;
  };
  return (one(a, b) + one(b, a)) / 2;
}

/** Named looks people ask for, as checks on a profile (0..1). */
const LOOK_WORDS: Record<string, (p: LookProfile) => number> = {
  warm: (p) => sig((p.warmth - 0.04) / 0.03),
  cool: (p) => sig((-p.warmth - 0.01) / 0.03),
  cold: (p) => sig((-p.warmth - 0.01) / 0.03),
  dark: (p) => sig((0.3 - p.brightness) / 0.06),
  bright: (p) => sig((p.brightness - 0.5) / 0.06),
  vivid: (p) => sig((p.saturation - 0.3) / 0.05),
  colorful: (p) => sig((p.saturation - 0.3) / 0.05),
  muted: (p) => sig((0.15 - p.saturation) / 0.04),
  "black and white": (p) => sig((0.05 - p.saturation) / 0.015),
  contrasty: (p) => sig((p.contrast - 0.22) / 0.04),
  soft: (p) => sig((0.14 - p.contrast) / 0.04),
};
const sig = (x: number) => 1 / (1 + Math.exp(-x));

/** Simple colour names → a reference colour. */
const COLOUR_NAMES: Record<string, string> = {
  red: "#c0392b", orange: "#e67e22", amber: "#d9902f", yellow: "#f1c40f", gold: "#c9a227", green: "#3c8d40", teal: "#1f8a8a",
  cyan: "#22b8cf", blue: "#2f5fa8", navy: "#1b2a4a", purple: "#7d3c98", pink: "#e06c9f", magenta: "#c0369d", brown: "#6e4b2a",
  beige: "#d8c3a5", cream: "#efe6d2", white: "#f2f2f2", grey: "#808080", gray: "#808080", black: "#111111",
};

/**
 * Pure: how well a clip's look fits a request (0..1).
 * Request: a look word ("warm", "dark"…), a colour name or hex ("blue", "#1e3a5f"), several joined
 * by spaces/commas ("moody blue" → the parts we know), or another clip's profile.
 */
export function lookFit(p: LookProfile, want: string | LookProfile): number | undefined {
  if (typeof want !== "string") return Math.exp(-paletteDistance(p.palette, want.palette) / 25) * 0.7 + Math.exp(-Math.abs(p.brightness - want.brightness) / 0.15) * 0.3;
  const s = want.toLowerCase().trim();
  const parts: number[] = [];
  const rest = s.replace(/black and white/g, () => {
    parts.push(LOOK_WORDS["black and white"]!(p));
    return "";
  });
  for (const w of rest.split(/[\s,/+&]+|\band\b/).filter(Boolean)) {
    if (LOOK_WORDS[w]) parts.push(LOOK_WORDS[w]!(p));
    else if (COLOUR_NAMES[w] || /^#?[0-9a-f]{6}$/.test(w)) parts.push(colourShare(p, hexToLab(COLOUR_NAMES[w] ?? w)));
  }
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : undefined;
}

/** Share of the palette close to a colour (ΔE < 25 counts fully, fading to 0 at 50). */
function colourShare(p: LookProfile, lab: [number, number, number]): number {
  const s = p.palette.reduce((acc, c) => acc + c.share * Math.max(0, Math.min(1, (50 - dE(c.lab, lab)) / 25)), 0);
  return Math.min(1, s * 2);
}

/** Words lookFit understands (for tool docs and to split a query into look vs mood words). */
export const LOOK_VOCAB = [...Object.keys(LOOK_WORDS), ...Object.keys(COLOUR_NAMES)];
