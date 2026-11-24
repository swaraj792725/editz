/** Pure helpers for the updater (kept apart so tests don't start the updater). */

export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a) return false;
  if (!b) return true; // unknown install: offer the release
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export interface UpdaterState {
  /** "Later" on this version: don't ask again until `until` (ms). A newer version asks at once. */
  snoozed?: { version: string; until: number };
}

export const SNOOZE_MS = 6 * 60 * 60_000;

export function shouldAsk(state: UpdaterState, version: string, now: number): boolean {
  return !(state.snoozed && state.snoozed.version === version && now < state.snoozed.until);
}

/** Release body (one "- subject" line per commit) → a short list for the dialog. */
export function shortNotes(body: string | null | undefined, max = 6): string {
  const lines = (body ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => "• " + l.slice(2).trim().slice(0, 90));
  if (lines.length <= max) return lines.join("\n");
  return [...lines.slice(0, max), `…and ${lines.length - max} more`].join("\n");
}

/** osascript prints "button returned:Update now, gave up:false". */
export function parseDialog(out: string): { button: string | null; gaveUp: boolean } {
  const b = /button returned:([^,\n]*)/.exec(out);
  return { button: b ? b[1]!.trim() || null : null, gaveUp: /gave up:true/.test(out) };
}
