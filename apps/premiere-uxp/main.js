/*
 * Editz UXP bridge (Premiere Pro 25.6+). M0 = hello-world: connect, authenticate,
 * answer `info`. Timeline ops land in M1; until then the daemon routes builds
 * through FCP7 XML import on UXP-only versions.
 * Same wire protocol as the CEP panel: daemon → {id, op, args}; panel → {id, ok, result|error}.
 */
const uxp = require("uxp");
const os = require("os");
const ppro = require("premierepro");

const PORT = 47800;
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
let retryMs = 1000;

function log(msg) {
  logEl.textContent = (new Date().toLocaleTimeString() + "  " + msg + "\n" + logEl.textContent).slice(0, 4000);
}

async function readToken() {
  const home = os.homedir();
  const path =
    os.platform() === "win32"
      ? home + "\\AppData\\Roaming\\Editz\\bridge-token"
      : home + "/Library/Application Support/Editz/bridge-token";
  try {
    const entry = await uxp.storage.localFileSystem.getEntryWithUrl("file:" + path);
    return String(await entry.read()).trim();
  } catch (e) {
    return null;
  }
}

const ops = {
  async info() {
    const project = await ppro.Project.getActiveProject();
    return {
      appVersion: String(uxp.host.version),
      projectPath: project ? String(project.path) : null,
      projectName: project ? String(project.name) : null,
      hasQE: false,
      hasEncoder: true,
      backend: "uxp",
    };
  },
};

async function runOp(msg) {
  const fn = ops[msg.op];
  if (!fn) return { ok: false, error: "Op not implemented on UXP yet: " + msg.op };
  try {
    return { ok: true, result: await fn(msg.args || {}) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function connect() {
  const token = await readToken();
  if (!token) {
    statusEl.textContent = "Waiting for Editz to start…";
    return setTimeout(connect, 3000);
  }
  statusEl.textContent = "Connecting…";
  const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/premiere");
  let queue = Promise.resolve();
  ws.onopen = async () => {
    const info = await runOp({ op: "info" });
    ws.send(JSON.stringify({ type: "hello", token, backend: "uxp", info: info.ok ? info.result : null }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg.type === "welcome") {
      retryMs = 1000;
      statusEl.textContent = "Connected to Editz";
      return log("connected");
    }
    if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
    if (!msg.id || !msg.op) return;
    queue = queue.then(async () => {
      log("→ " + msg.op);
      const res = await runOp(msg);
      if (ws.readyState === 1) ws.send(JSON.stringify({ id: msg.id, ...res }));
    });
  };
  ws.onclose = (ev) => {
    statusEl.textContent = ev.code === 4001 ? "Editz rejected this panel (token)" : "Editz not running — retrying";
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 15000);
  };
}

connect();
