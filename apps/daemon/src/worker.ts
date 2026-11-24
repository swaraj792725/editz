import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { findTool } from "./media/ffmpeg.ts";
import { supportDir } from "./paths.ts";

/**
 * Client for the Python worker (workers/editz-worker): JSON lines over stdio.
 * One worker process, requests answered in order. It is started on first use and
 * stopped after a quiet spell, so models don't sit in RAM while Premiere needs it.
 */

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
  }
}

export interface WorkerCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface CallOptions {
  timeoutMs?: number;
  onProgress?: (message: string, value: number | null) => void;
}

export interface WorkerOptions {
  /** Stop the process after this long with nothing to do (frees model memory). Default 5 min. */
  idleMs?: number;
  /** First start may install Python packages, so this is generous. Default 15 min. */
  startTimeoutMs?: number;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string; onProgress?: CallOptions["onProgress"] };

export class PyWorker {
  private proc: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private idleTimer: NodeJS.Timeout | undefined;
  private stderrTail: string[] = [];

  constructor(
    private command: () => WorkerCommand | Promise<WorkerCommand>,
    private opts: WorkerOptions = {},
  ) {}

  get running(): boolean {
    return !!this.proc;
  }

  async call<T = unknown>(method: string, params: object = {}, o: CallOptions = {}): Promise<T> {
    clearTimeout(this.idleTimer);
    await this.start();
    const proc = this.proc!;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkerError(`${method} took longer than ${Math.round((o.timeoutMs ?? 0) / 1000)} s`, "Timeout"));
        this.stop(); // a stuck model is not coming back; a fresh process is cheaper than waiting
      }, o.timeoutMs ?? 30 * 60_000);
      this.pending.set(id, { resolve, reject, timer, method, onProgress: o.onProgress });
      proc.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    }).finally(() => this.armIdle());
  }

  stop(): void {
    clearTimeout(this.idleTimer);
    const p = this.proc;
    this.proc = undefined;
    this.starting = undefined;
    if (p && p.exitCode === null) {
      p.stdin?.end();
      p.kill("SIGTERM");
      setTimeout(() => p.exitCode === null && p.kill("SIGKILL"), 3000).unref();
    }
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    if (this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => this.stop(), this.opts.idleMs ?? 5 * 60_000);
    this.idleTimer.unref();
  }

  private start(): Promise<void> {
    if (this.proc) return Promise.resolve();
    this.starting ??= this.spawn().catch((e) => {
      this.starting = undefined;
      throw e;
    });
    return this.starting;
  }

  private async spawn(): Promise<void> {
    const c = await this.command();
    const proc = spawn(c.command, c.args, { cwd: c.cwd, env: { ...process.env, ...c.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.stderrTail = [];
    createInterface({ input: proc.stderr! }).on("line", (l) => {
      this.stderrTail.push(l);
      if (this.stderrTail.length > 30) this.stderrTail.shift();
    });

    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new WorkerError(`worker did not start in time\n${this.tail()}`, "StartTimeout"));
      }, this.opts.startTimeoutMs ?? 15 * 60_000);

      createInterface({ input: proc.stdout! }).on("line", (line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return; // not ours
        }
        if (msg.event === "ready" && !ready) {
          ready = true;
          clearTimeout(timer);
          this.proc = proc;
          resolve();
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.event === "progress") return p.onProgress?.(String(msg.message ?? ""), msg.value ?? null);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new WorkerError(msg.error.message, msg.error.kind ?? "Error"));
        else p.resolve(msg.result);
      });

      const fail = (why: string) => {
        clearTimeout(timer);
        if (this.proc === proc) this.proc = undefined;
        this.starting = undefined;
        const err = new WorkerError(`worker ${why}\n${this.tail()}`, "WorkerExit");
        if (!ready) reject(err);
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new WorkerError(`${p.method} failed: worker ${why}\n${this.tail()}`, "WorkerExit"));
          this.pending.delete(id);
        }
      };
      proc.on("error", (e) => fail(`could not start (${e.message})`));
      proc.on("exit", (code, signal) => fail(`stopped (${signal ?? `exit ${code}`})`));
    });
  }

  private tail(): string {
    return this.stderrTail.slice(-8).join("\n");
  }
}

function isExec(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** uv runs the worker in its own Python env. env override → bundled → PATH → usual install spots. */
export function findUv(): string {
  const env = process.env.EDITZ_UV;
  if (env && isExec(env)) return env;
  const exe = process.platform === "win32" ? "uv.exe" : "uv";
  const dirs = [
    join(supportDir(), "bin"),
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const d of dirs) if (d && isExec(join(d, exe))) return join(d, exe);
  throw new WorkerError("uv not found. Editz uses the free tool uv to run its local AI (the installer ships it; for now: brew install uv).", "ToolMissing");
}

export function workerProjectDir(): string {
  if (process.env.EDITZ_WORKER_DIR) return process.env.EDITZ_WORKER_DIR;
  // Installed copies ship one bundled editz.mjs with the worker beside it; dev checkouts use the repo.
  const beside = fileURLToPath(new URL("./worker", import.meta.url));
  if (existsSync(join(beside, "pyproject.toml"))) return beside;
  return fileURLToPath(new URL("../../../workers/editz-worker", import.meta.url));
}

export function modelsDir(): string {
  return process.env.EDITZ_MODELS ?? join(supportDir(), "models");
}

export function defaultWorkerCommand(): WorkerCommand {
  const dir = workerProjectDir();
  const uv = findUv();
  const env: Record<string, string> = {
    EDITZ_MODELS: modelsDir(),
    HF_HOME: join(modelsDir(), "hf"),
    HF_HUB_DISABLE_TELEMETRY: "1",
    PYTHONUNBUFFERED: "1",
    // Belt and braces: the package imports from source even if the editable install is stale.
    PYTHONPATH: [dir, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    PATH: [dirname(findTool("ffmpeg")), process.env.PATH ?? ""].join(delimiter),
  };
  // Dev checkouts keep their .venv; installed copies keep the env in the support dir.
  if (!existsSync(join(dir, ".venv"))) env.UV_PROJECT_ENVIRONMENT = join(supportDir(), "py", "editz-worker");
  const uvArgs = ["run", "--quiet", "--frozen", "--project", dir, "python", "-m", "editz_worker"];
  // Utility QoS on macOS: still uses the GPU, but yields to Premiere's playback threads.
  if (process.platform === "darwin" && isExec("/usr/sbin/taskpolicy")) {
    return { command: "/usr/sbin/taskpolicy", args: ["-c", "utility", uv, ...uvArgs], env, cwd: dir };
  }
  return { command: uv, args: uvArgs, env, cwd: dir };
}
