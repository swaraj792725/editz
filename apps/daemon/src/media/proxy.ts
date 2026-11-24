import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { ingest } from "./analyze.ts";
import { makeProxy, type MediaInfo } from "./ffmpeg.ts";
import type { MediaIndex } from "./index-db.ts";

/** Light edit copies for heavy footage, so a non-editor's laptop scrubs smoothly. */

export type ProxyPlan = { make: true; out: string; height: number; audioChannels?: number } | { make: false; reason: string; out?: string };

/** Pure: should this file get a proxy, and where. Small footage (≤ target height) is already light. */
export function proxyPlan(info: MediaInfo, src: string, outDir?: string, height = 540): ProxyPlan {
  if (info.isImage) return { make: false, reason: "still image" };
  if (!info.hasVideo) return { make: false, reason: "audio only" };
  if ((info.height ?? 0) > 0 && Math.min(info.height!, info.width ?? info.height!) <= height) return { make: false, reason: `already light (${info.width}x${info.height})` };
  const out = join(outDir ?? join(dirname(src), "Proxies"), `${basename(src, extname(src))}_Proxy.mp4`);
  // Even height keeps H.264 happy; portrait phone clips keep their short side at `height`.
  const portrait = (info.height ?? 0) > (info.width ?? 0);
  const h = portrait ? Math.round(((info.height! / info.width!) * height) / 2) * 2 : height;
  return { make: true, out, height: h, audioChannels: info.hasAudio ? (info.audioChannels ?? 2) : undefined };
}

export interface ProxyResult {
  media: string;
  proxy?: string;
  made: boolean;
  skipped?: string;
  error?: string;
}

export async function makeProxies(index: MediaIndex, files: string[], o: { outDir?: string; height?: number; force?: boolean; onProgress?: (m: string, v: number | null) => void } = {}): Promise<ProxyResult[]> {
  const out: ProxyResult[] = [];
  for (const [i, f] of files.entries()) {
    try {
      const m = await ingest(index, f);
      const plan = proxyPlan(m.info, f, o.outDir, o.height);
      if (!plan.make) {
        out.push({ media: f, made: false, skipped: plan.reason });
        continue;
      }
      const fresh = existsSync(plan.out) && statSync(plan.out).mtimeMs >= statSync(f).mtimeMs;
      if (fresh && !o.force) {
        out.push({ media: f, proxy: plan.out, made: false, skipped: "proxy already there" });
      } else {
        o.onProgress?.(`proxy ${i + 1}/${files.length}: ${basename(f)}`, i / files.length);
        mkdirSync(dirname(plan.out), { recursive: true });
        await makeProxy(f, plan.out, { height: plan.height, audioChannels: plan.audioChannels });
        out.push({ media: f, proxy: plan.out, made: true });
      }
      index.putAnalysis(m.checksum, "proxy/v1", { path: plan.out });
    } catch (e) {
      out.push({ media: f, made: false, error: (e as Error).message });
    }
  }
  return out;
}
