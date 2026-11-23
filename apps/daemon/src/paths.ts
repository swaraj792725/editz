import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Per-user Editz support dir. Panels read the bridge token from here. */
export function supportDir(): string {
  if (process.env.EDITZ_HOME) return process.env.EDITZ_HOME;
  if (platform() === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Editz");
  return join(homedir(), "Library", "Application Support", "Editz");
}

/** Default folder for generated XML, renders, logs. */
export function workDir(): string {
  return process.env.EDITZ_WORK ?? join(homedir(), "Movies", "Editz");
}

/**
 * Shared secret between daemon and panels. Browsers allow cross-origin WebSocket,
 * so any web page could otherwise reach 127.0.0.1:47800 and drive Premiere.
 */
export function ensureToken(dir = supportDir()): string {
  const file = join(dir, "bridge-token");
  mkdirSync(dir, { recursive: true });
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t.length >= 32) return t;
  }
  const t = randomBytes(32).toString("hex");
  writeFileSync(file, t + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return t;
}
