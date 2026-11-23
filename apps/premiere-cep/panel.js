/*
 * Editz CEP panel: connects Premiere (ExtendScript) to the local Editz daemon.
 * Panel is the WebSocket *client*; daemon listens on 127.0.0.1:47800.
 * Protocol: daemon → {id, op, args}; panel → {id, ok, result | error}.
 * Runs in CEP's Chromium, so modern JS is fine here (not in host/editz.jsx).
 */
(function () {
  "use strict";
  var PORT = 47800;
  var cep = window.__adobe_cep__;
  var statusEl = document.getElementById("status");
  var dotEl = document.getElementById("dot");
  var logEl = document.getElementById("log");
  var ws = null;
  var retryMs = 1000;

  function log(msg) {
    var line = new Date().toLocaleTimeString() + "  " + msg;
    logEl.textContent = (line + "\n" + logEl.textContent).slice(0, 4000);
  }
  function setStatus(text, on) {
    statusEl.textContent = text;
    dotEl.className = on ? "dot on" : "dot";
  }

  function systemPath(kind) {
    var p = decodeURI(cep.getSystemPath(kind));
    p = p.replace(/^file:\/{2,3}/, navigator.platform.indexOf("Win") === 0 ? "" : "/");
    return p;
  }

  function evalScript(code) {
    return new Promise(function (resolve) {
      cep.evalScript(code, resolve);
    });
  }

  /** Make sure the host lib is loaded (ScriptPath sometimes isn't on older builds). */
  function ensureHost() {
    return evalScript("typeof EditzHost").then(function (t) {
      if (t === "object") return;
      var file = systemPath("extension") + "/host/editz.jsx";
      return evalScript("$.evalFile(" + JSON.stringify(file) + ")");
    });
  }

  function readToken() {
    var file = systemPath("userData") + "/Editz/bridge-token";
    var r = window.cep && window.cep.fs ? window.cep.fs.readFile(file) : { err: 1 };
    return r.err === 0 ? String(r.data).trim() : null;
  }

  /** JSON as an ES3-safe JS string literal (U+2028/9 are line breaks in ES3). */
  function jsLiteral(obj) {
    var LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
    return JSON.stringify(JSON.stringify(obj)).split(LS).join("\\u2028").split(PS).join("\\u2029");
  }

  function runOp(msg) {
    var code = "EditzHost.call(" + JSON.stringify(msg.op) + "," + jsLiteral(msg.args || {}) + ")";
    return evalScript(code).then(function (out) {
      try {
        return JSON.parse(out);
      } catch (e) {
        return { ok: false, error: "Host returned non-JSON: " + String(out).slice(0, 200) };
      }
    });
  }

  // One op at a time: ExtendScript is single-threaded and Premiere hates overlap.
  var queue = Promise.resolve();

  function connect() {
    var token = readToken();
    if (!token) {
      setStatus("Waiting for Editz to start…", false);
      return setTimeout(connect, 3000);
    }
    setStatus("Connecting…", false);
    ws = new WebSocket("ws://127.0.0.1:" + PORT + "/premiere");
    ws.onopen = function () {
      ensureHost()
        .then(function () { return runOp({ op: "info" }); })
        .then(function (info) {
          ws.send(JSON.stringify({ type: "hello", token: token, backend: "cep", info: info.ok ? info.result : null }));
        });
    };
    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.type === "welcome") {
        retryMs = 1000;
        setStatus("Connected to Editz", true);
        log("connected");
        return;
      }
      if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
      if (!msg.id || !msg.op) return;
      queue = queue
        .then(function () {
          log("→ " + msg.op);
          return runOp(msg);
        })
        .then(function (res) {
          if (!res.ok) log("✗ " + msg.op + ": " + res.error);
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ id: msg.id, ok: res.ok, result: res.result, error: res.error }));
        });
    };
    ws.onclose = function (ev) {
      setStatus(ev.code === 4001 ? "Editz rejected this panel (token)" : "Editz not running — retrying", false);
      ws = null;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
    ws.onerror = function () {};
  }

  connect();
})();
