import type { Rate } from "./schema.ts";

/** Premiere's internal tick rate (ticks per second). */
export const PPRO_TICKS_PER_SECOND = 254016000000;

export function fps(rate: Rate): number {
  return rate.num / rate.den;
}

/** FCP7 XML expresses rates as integer timebase + NTSC flag. */
export function toXmlRate(rate: Rate): { timebase: number; ntsc: boolean } {
  if (rate.den === 1001) return { timebase: Math.round(rate.num / 1000), ntsc: true };
  if (rate.num % rate.den === 0) return { timebase: rate.num / rate.den, ntsc: false };
  throw new Error(`Unsupported frame rate ${rate.num}/${rate.den} for FCP7 XML`);
}

export function fromXmlRate(timebase: number, ntsc: boolean): Rate {
  return ntsc ? { num: timebase * 1000, den: 1001 } : { num: timebase, den: 1 };
}

export function framesToSeconds(frames: number, rate: Rate): number {
  return (frames * rate.den) / rate.num;
}

export function secondsToFrames(seconds: number, rate: Rate): number {
  return Math.round((seconds * rate.num) / rate.den);
}

/** Premiere ticks for an integer frame count. Exact for all standard rates. */
export function framesToTicks(frames: number, rate: Rate): bigint {
  return (BigInt(frames) * BigInt(PPRO_TICKS_PER_SECOND) * BigInt(rate.den)) / BigInt(rate.num);
}

export function ticksToFrames(ticks: bigint | string | number, rate: Rate): number {
  const t = BigInt(ticks);
  const num = t * BigInt(rate.num);
  const den = BigInt(PPRO_TICKS_PER_SECOND) * BigInt(rate.den);
  // round half up
  return Number((num * 2n + den) / (den * 2n));
}
