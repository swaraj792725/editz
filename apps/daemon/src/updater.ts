/**
 * Update checker. The installer adds a macOS LaunchAgent that runs this every 30 minutes
 * (and at login). When GitHub has a newer release it asks "Update now / Later" in a dialog,
 * then reruns that release's installer in the background and offers to restart Claude.
 *
 * Usage: node updater.mjs            check, ask, update
 *        node updater.mjs --check    print current/latest only
 *        node updater.mjs --yes      no dialogs: update if newer (testing)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { supportDir } from "./paths.ts";
import { SNOOZE_MS, isNewer, parseDialog, shortNotes, shouldAsk, type UpdaterState } from "./update-core.ts";

const REPO = process.env.EDITZ_REPO ?? "swaraj792725/editz";
const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const auto = argv.includes("--yes");
const log = (m: string) => process.stdout.write(`[${new Date().toISOString()}] ${m}\n`);

const appDir = dirname(fileURLToPath(import.meta.url));
const versionFile = join(appDir, "VERSION");
const current = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : "0.0.0";
const stateFile = join(supportDir(), "updater.json");

function readState(): UpdaterState {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as UpdaterState;
  } catch {
    return {};
  }
}
function writeState(s: UpdaterState) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(s) + "\n");
}

function osa(lines: string[], args: string[]): string {
  const r = spawnSync("/usr/bin/osascript", [...lines.flatMap((l) => ["-e", l]), ...args], { encoding: "utf8" });
  return r.stdout ?? "";
}
/** Buttons are fixed labels from this file (no quotes in them); the message goes in as an argument. */
function dialog(message: string, buttons: string[], giveUpS = 3600): string | null {
  const list = buttons.map((b) => `"${b}"`).join(", ");
  const out = osa(
    ["on run argv", `display dialog (item 1 of argv) with title "Editz" with icon note buttons {${list}} default button "${buttons.at(-1)}" giving up after ${giveUpS}`, "end run"],
    [message],
  );
  const d = parseDialog(out);
  return d.gaveUp ? null : d.button;
}
function notify(message: string) {
  osa(["on run argv", `display notification (item 1 of argv) with title "Editz"`, "end run"], [message]);
}

async function latestRelease(): Promise<{ version: string; tag: string; notes: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": "editz-updater", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { tag_name?: string; body?: string };
  if (!j.tag_name) return null;
  return { version: j.tag_name.replace(/^v/, ""), tag: j.tag_name, notes: shortNotes(j.body) };
}

async function installerScript(tag: string): Promise<string> {
  if (process.env.EDITZ_INSTALL_SCRIPT) return process.env.EDITZ_INSTALL_SCRIPT;
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/install.sh`, {
    headers: { "User-Agent": "editz-updater" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`could not download the installer (HTTP ${res.status})`);
  const file = join(tmpdir(), `editz-install-${tag}.sh`);
  writeFileSync(file, await res.text(), { mode: 0o700 });
  return file;
}

function runInstaller(script: string, tag: string, logFile: string): Promise<number> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EDITZ_UPDATING: "1",
    // Same release as the dialog promised, even if another lands meanwhile.
    EDITZ_BUNDLE_URL: process.env.EDITZ_BUNDLE_URL ?? `https://github.com/${REPO}/releases/download/${tag}/editz-mac.tar.gz`,
    PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  const fd = openSync(logFile, "w");
  return new Promise((resolve) => {
    const p = spawn("/bin/bash", [script], { env, stdio: ["ignore", fd, fd] });
    p.on("error", () => resolve(127));
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

function restartClaude() {
  spawnSync("/usr/bin/pkill", ["-TERM", "-x", "Claude"]);
  for (let i = 0; i < 30 && spawnSync("/usr/bin/pgrep", ["-x", "Claude"]).status === 0; i++) spawnSync("/bin/sleep", ["1"]);
  spawnSync("/usr/bin/open", ["-a", "Claude"]);
}

async function main() {
  let latest;
  try {
    latest = await latestRelease();
  } catch {
    return; // offline or GitHub down: try again next round, quietly
  }
  if (checkOnly) {
    console.log(JSON.stringify({ current, latest: latest?.version ?? null, update: !!latest && isNewer(latest.version, current) }));
    return;
  }
  if (!latest || !isNewer(latest.version, current)) return;

  const state = readState();
  if (!auto && !shouldAsk(state, latest.version, Date.now())) return;
  log(`update available: ${current} → ${latest.version}`);

  if (!auto) {
    const msg =
      `A new Editz test build is ready: ${latest.version} (you have ${current}).\n\n` +
      (latest.notes ? `What changed:\n${latest.notes}\n\n` : "") +
      "Updating takes a minute or two and runs in the background.";
    const choice = dialog(msg, ["Later", "Update now"]);
    if (choice !== "Update now") {
      if (choice === "Later") writeState({ ...state, snoozed: { version: latest.version, until: Date.now() + SNOOZE_MS } });
      log(choice === "Later" ? "snoozed" : "no answer");
      return;
    }
    notify(`Updating Editz to ${latest.version}…`);
  }

  const logs = join(supportDir(), "logs");
  mkdirSync(logs, { recursive: true });
  const logFile = join(logs, `update-${latest.version}.log`);
  let code: number;
  try {
    code = await runInstaller(await installerScript(latest.tag), latest.tag, logFile);
  } catch (e) {
    writeFileSync(logFile, String((e as Error).message) + "\n");
    code = 1;
  }
  log(`installer exited ${code}; log ${logFile}`);
  writeState({});
  if (auto) {
    process.exitCode = code;
    return;
  }

  if (code !== 0) {
    if (dialog(`The Editz update to ${latest.version} did not finish. Editz may still work on the old version.\n\nDetails: ${logFile}\nSend that file to whoever shared Editz with you.`, ["OK", "Show log"]) === "Show log") {
      spawnSync("/usr/bin/open", ["-R", logFile]);
    }
    return;
  }
  const after = dialog(
    `Editz is now ${latest.version}.\n\nRestart Claude so it uses the new version (your chats are kept). If Premiere is open, restart it too once your project is saved.`,
    ["Later", "Restart Claude"],
  );
  if (after === "Restart Claude") restartClaude();
}

await main();
