/**
 * Installer step: build the Python env and fetch the core AI models now, in the Terminal,
 * so the first request from Claude doesn't sit for minutes on a download.
 * Usage: node warmup.mjs [--skip-models]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { findTool, run } from "./media/ffmpeg.ts";
import { supportDir } from "./paths.ts";
import { DEFAULT_ASR_MODEL } from "./speech/service.ts";
import { PyWorker, defaultWorkerCommand } from "./worker.ts";

const skipModels = process.argv.includes("--skip-models");
const say = (m: string) => process.stdout.write(m + "\n");
let last = "";
const onProgress = (m: string, v: number | null) => {
  const line = v == null ? m : `${m} ${Math.round(v * 100)}%`;
  if (line !== last) say(`    ${line}`);
  last = line;
};

const w = new PyWorker(defaultWorkerCommand, { idleMs: 60 * 60_000, startTimeoutMs: 60 * 60_000 });
try {
  say("  • Starting the local AI helper (first time sets up Python, a few minutes)…");
  const info = await w.call<{ python: string; machine: string }>("ping", {}, { timeoutMs: 30 * 60_000 });
  say(`    ready (Python ${info.python}, ${info.machine})`);
  if (!skipModels) {
    say("  • Fetching the picture model (SigLIP 2)…");
    await w.call("embed_texts", { texts: ["a cup of coffee"] }, { onProgress, timeoutMs: 60 * 60_000 });
    say("  • Fetching the voice model (Kokoro)…");
    await w.call("voices", {}, { onProgress, timeoutMs: 60 * 60_000 });
    say("  • Fetching the speech-to-text model (Whisper, the big one)…");
    const tmp = join(supportDir(), "cache");
    mkdirSync(tmp, { recursive: true });
    const wav = join(tmp, "warmup.wav");
    await run(findTool("ffmpeg"), ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", wav]);
    await w.call("transcribe", { path: wav, model: DEFAULT_ASR_MODEL }, { onProgress, timeoutMs: 120 * 60_000 });
  }
  say("  • AI helper OK");
} catch (e) {
  process.stderr.write(`\nThe AI helper could not start: ${(e as Error).message}\n`);
  process.exitCode = 1;
} finally {
  w.stop();
}
