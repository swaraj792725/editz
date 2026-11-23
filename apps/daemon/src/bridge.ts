import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { HostInfo, OpName } from "@editz/compilers";

export interface BridgeOptions {
  port?: number;
  host?: string;
  token: string;
  log?: (msg: string) => void;
  helloTimeoutMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class BridgeError extends Error {}

/**
 * WebSocket server the Premiere panels (CEP or UXP) connect to.
 * Panels are clients because UXP cannot listen. One live panel at a time; newest wins.
 */
export class Bridge {
  private wss?: WebSocketServer;
  private sock: WebSocket | null = null;
  private info: HostInfo | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private log: (m: string) => void;
  readonly port: number;
  readonly host: string;

  constructor(private opts: BridgeOptions) {
    this.port = opts.port ?? 47800;
    this.host = opts.host ?? "127.0.0.1";
    this.log = opts.log ?? ((m) => process.stderr.write(`[bridge] ${m}\n`));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.host, port: this.port, path: "/premiere", maxPayload: 64 * 1024 * 1024 });
      wss.once("listening", () => {
        this.wss = wss;
        resolve();
      });
      wss.once("error", reject);
      wss.on("connection", (ws, req) => this.onConnection(ws, req.headers.origin));
    });
  }

  async stop(): Promise<void> {
    for (const p of this.pending.values()) p.reject(new BridgeError("bridge stopped"));
    this.pending.clear();
    this.sock?.close();
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
  }

  get connected(): HostInfo | null {
    return this.sock && this.sock.readyState === 1 ? this.info : null;
  }

  private onConnection(ws: WebSocket, origin: string | undefined) {
    // Web pages send an http(s) Origin; CEP sends file:// or none, UXP none.
    if (origin && /^https?:/i.test(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      this.log(`rejected origin ${origin}`);
      return ws.close(4003, "origin");
    }
    let authed = false;
    const helloTimer = setTimeout(() => !authed && ws.close(4001, "no hello"), this.opts.helloTimeoutMs ?? 5000);
    ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!authed) {
        if (msg?.type !== "hello" || !tokenOk(String(msg.token ?? ""), this.opts.token)) {
          this.log("rejected panel: bad token");
          return ws.close(4001, "token");
        }
        authed = true;
        clearTimeout(helloTimer);
        if (this.sock && this.sock !== ws) this.sock.close(4002, "replaced");
        this.sock = ws;
        const info: HostInfo = { ...(msg.info ?? {}), backend: msg.backend === "uxp" ? "uxp" : "cep" };
        this.info = info;
        ws.send(JSON.stringify({ type: "welcome" }));
        this.log(`panel connected: ${info.backend} Premiere ${info.appVersion ?? "?"}`);
        return;
      }
      if (msg?.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new BridgeError(String(msg.error ?? "host error")));
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.sock === ws) {
        this.sock = null;
        this.info = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new BridgeError("Premiere panel disconnected"));
          this.pending.delete(id);
        }
        this.log("panel disconnected");
      }
    });
  }

  /** Send one op to Premiere and wait for its result. */
  request<T = unknown>(op: OpName, args: object = {}, timeoutMs = 60_000): Promise<T> {
    const ws = this.sock;
    if (!ws || ws.readyState !== 1) return Promise.reject(new BridgeError("No Premiere panel connected"));
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`Premiere did not answer ${op} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, op, args }));
    });
  }
}

function tokenOk(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
