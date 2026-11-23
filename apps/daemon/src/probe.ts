import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import type { HostInfo } from "@editz/compilers";

export type Tier = "uxp" | "cep" | "xml";

export interface Install {
  path: string;
  version: string;
  tiers: Tier[];
}

export interface Probe {
  installs: Install[];
  live: HostInfo | null;
  /** How build_sequence will run right now. */
  route: "cep-live" | "xml-guided";
  notes: string[];
}

/** "25.6.1" → [25, 6, 1] */
export function parseVersion(v: string): number[] {
  return v.split(/[^\d]+/).filter(Boolean).map(Number);
}

function gte(v: number[], min: number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = v[i] ?? 0;
    const b = min[i]!;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Bridge tiers a Premiere version supports, best first.
 * UXP: 25.6+. CEP/ExtendScript: CC 2018 (12.0) through 25.x (Adobe is retiring it after 25).
 * FCP7 XML import works on every version since CS5.
 */
export function tiersFor(version: string): Tier[] {
  const v = parseVersion(version);
  const out: Tier[] = [];
  if (gte(v, [25, 6])) out.push("uxp");
  if (gte(v, [12, 0]) && !gte(v, [26, 0])) out.push("cep");
  out.push("xml");
  return out;
}

function plistVersion(plist: string): string | null {
  try {
    const xml = readFileSync(plist, "utf8");
    const m = xml.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    if (m) return m[1]!.trim();
  } catch {
    /* fall through */
  }
  try {
    return execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", plist], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Find installed Premiere Pro versions (macOS bundle plists; Windows folder names). */
export function findInstalls(roots?: string[]): Install[] {
  const out: Install[] = [];
  if (platform() === "win32") {
    const base = roots?.[0] ?? "C:\\Program Files\\Adobe";
    if (!existsSync(base)) return out;
    for (const d of readdirSync(base)) {
      const m = d.match(/^Adobe Premiere Pro(?: CC)? (\d{4})$/);
      if (!m) continue;
      const year = Number(m[1]);
      // CC 2018 = 12, 2019 = 13, 2020 = 14, 2021 = 15, then 22 = 2022 onward.
      const major = year <= 2021 ? year - 2006 : year - 2000;
      out.push({ path: join(base, d), version: `${major}.0`, tiers: tiersFor(`${major}.0`) });
    }
    return out;
  }
  for (const root of roots ?? ["/Applications"]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      if (!d.startsWith("Adobe Premiere Pro")) continue;
      const dir = join(root, d);
      const apps = d.endsWith(".app") ? [dir] : safeList(dir).filter((f) => f.endsWith(".app")).map((f) => join(dir, f));
      for (const app of apps) {
        const v = plistVersion(join(app, "Contents", "Info.plist"));
        if (v) out.push({ path: app, version: v, tiers: tiersFor(v) });
      }
    }
  }
  return out.sort((a, b) => cmp(parseVersion(b.version), parseVersion(a.version)));
}

function safeList(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

export function probe(live: HostInfo | null, installs = findInstalls()): Probe {
  const notes: string[] = [];
  if (installs.length === 0) notes.push("No Premiere Pro install found in the usual place. Editz can still write timelines as XML files.");
  if (!live) notes.push("Editz panel not connected. Open Premiere, then Window → Extensions → Editz (or the UXP plugin on 25.6+).");
  let route: Probe["route"] = "xml-guided";
  if (live?.backend === "cep") route = "cep-live";
  else if (live?.backend === "uxp") notes.push("UXP panel connected (M0 hello-world). Timeline builds use XML import until UXP ops land in M1.");
  return { installs, live, route, notes };
}
