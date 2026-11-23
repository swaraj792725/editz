/*
 * Editz ExtendScript host library (Premiere Pro CC 2018 → 25.x).
 * ES3 only: no forEach/map/indexOf, no JSON on old hosts, no let/const.
 * Entry point: EditzHost.call(opName, jsonArgs) → JSON string {ok, result|error}.
 */

var EditzHost = (function () {
  // ---------- tiny JSON (ExtendScript before ~2020 has no JSON) ----------
  function quote(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === "\\") out += "\\\\";
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else if (code < 32) out += "\\u" + ("0000" + code.toString(16)).slice(-4);
      else out += c;
    }
    return out + '"';
  }

  function stringify(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return quote(v);
    if (Object.prototype.toString.call(v) === "[object Array]") {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(stringify(v[i]));
      return "[" + parts.join(",") + "]";
    }
    var kv = [];
    for (var k in v) {
      if (v.hasOwnProperty(k) && typeof v[k] !== "function") kv.push(quote(k) + ":" + stringify(v[k]));
    }
    return "{" + kv.join(",") + "}";
  }

  function parse(s) {
    // Input comes only from the local Editz daemon over an authenticated socket.
    if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(s);
    return eval("(" + s + ")");
  }

  // ---------- helpers ----------
  var TYPE_CLIP = 1, TYPE_BIN = 2, TYPE_ROOT = 3, TYPE_FILE = 4;

  function project() {
    if (!app.project) throw new Error("No open project");
    return app.project;
  }

  function childBinByName(parent, name) {
    for (var i = 0; i < parent.children.numItems; i++) {
      var c = parent.children[i];
      if (c && c.type === TYPE_BIN && c.name === name) return c;
    }
    return null;
  }

  function ensureBinPath(path) {
    var parts = String(path).split("/");
    var cur = project().rootItem;
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var next = childBinByName(cur, parts[i]);
      if (!next) {
        cur.createBin(parts[i]);
        next = childBinByName(cur, parts[i]);
        if (!next) throw new Error("Could not create bin " + parts[i]);
      }
      cur = next;
    }
    return cur;
  }

  function walk(item, fn, parent) {
    fn(item, parent);
    if (item.type === TYPE_BIN || item.type === TYPE_ROOT) {
      for (var i = 0; i < item.children.numItems; i++) walk(item.children[i], fn, item);
    }
  }

  function findByNodeId(nodeId) {
    var found = null;
    walk(project().rootItem, function (it) {
      if (!found && it.nodeId === nodeId) found = it;
    });
    return found;
  }

  function isSequenceItem(it) {
    try {
      if (typeof it.isSequence === "function") return it.isSequence();
    } catch (e) {}
    return false;
  }

  function mediaPathOf(it) {
    try {
      if (it.type === TYPE_CLIP || it.type === TYPE_FILE) return it.getMediaPath() || null;
    } catch (e) {}
    return null;
  }

  function kindOf(it) {
    if (it.type === TYPE_BIN) return "bin";
    if (isSequenceItem(it)) return "sequence";
    if (it.type === TYPE_CLIP) return "clip";
    if (it.type === TYPE_FILE) return "file";
    return "other";
  }

  function rootIds() {
    var ids = {};
    var root = project().rootItem;
    for (var i = 0; i < root.children.numItems; i++) ids[root.children[i].nodeId] = true;
    return ids;
  }

  function findSequence(name) {
    var seqs = project().sequences;
    for (var i = 0; i < seqs.numSequences; i++) if (seqs[i].name === name) return seqs[i];
    return null;
  }

  // ---------- ops ----------
  var ops = {};

  ops.info = function () {
    var p = app.project;
    var hasQE = false;
    try {
      app.enableQE();
      hasQE = typeof qe !== "undefined";
    } catch (e) {}
    return {
      appVersion: String(app.version),
      projectPath: p ? String(p.path) : null,
      projectName: p ? String(p.name) : null,
      hasQE: hasQE,
      hasEncoder: !!app.encoder,
      backend: "cep"
    };
  };

  ops.ensureBins = function (a) {
    var made = [];
    for (var i = 0; i < a.paths.length; i++) made.push(ensureBinPath(a.paths[i]).nodeId);
    return { nodeIds: made };
  };

  ops.importFiles = function (a) {
    var bin = ensureBinPath(a.bin);
    var ok = project().importFiles(a.paths, true, bin, false);
    return { ok: !!ok, bin: bin.nodeId };
  };

  ops.importXml = function (a) {
    var before = rootIds();
    var ok = project().importFiles([a.path], true, project().rootItem, false);
    if (!ok) throw new Error("Premiere refused to import " + a.path);
    var items = [];
    var root = project().rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
      var top = root.children[i];
      if (before[top.nodeId]) continue;
      walk(top, function (it, parent) {
        items.push({
          nodeId: it.nodeId,
          parentNodeId: parent && parent.type !== TYPE_ROOT ? parent.nodeId : null,
          name: it.name,
          kind: kindOf(it),
          mediaPath: mediaPathOf(it)
        });
      }, root);
    }
    return { items: items };
  };

  ops.moveItems = function (a) {
    var moved = 0, missing = [];
    for (var i = 0; i < a.moves.length; i++) {
      var it = findByNodeId(a.moves[i].nodeId);
      if (!it) {
        missing.push(a.moves[i].nodeId);
        continue;
      }
      it.moveBin(ensureBinPath(a.moves[i].bin));
      moved++;
    }
    return { moved: moved, missing: missing };
  };

  ops.deleteBins = function (a) {
    var deleted = 0;
    for (var i = 0; i < a.nodeIds.length; i++) {
      var b = findByNodeId(a.nodeIds[i]);
      if (b && b.type === TYPE_BIN && b.children.numItems === 0) {
        b.deleteBin();
        deleted++;
      }
    }
    return { deleted: deleted };
  };

  ops.listSequences = function () {
    var out = [];
    var seqs = project().sequences;
    for (var i = 0; i < seqs.numSequences; i++) out.push({ name: seqs[i].name, id: seqs[i].sequenceID });
    return { sequences: out };
  };

  function readTracks(tracks) {
    var out = [];
    for (var t = 0; t < tracks.numTracks; t++) {
      var tr = tracks[t];
      var items = [];
      for (var c = 0; c < tr.clips.numItems; c++) {
        var ti = tr.clips[c];
        var mp = "";
        try {
          mp = ti.projectItem ? ti.projectItem.getMediaPath() : "";
        } catch (e) {}
        items.push({
          name: ti.name,
          mediaPath: mp,
          start: String(ti.start.ticks),
          end: String(ti.end.ticks),
          inPoint: String(ti.inPoint.ticks)
        });
      }
      out.push(items);
    }
    return out;
  }

  ops.readSequence = function (a) {
    var seq = findSequence(a.name);
    if (!seq) throw new Error("Sequence not found: " + a.name);
    var markers = [];
    var m = seq.markers.getFirstMarker();
    var guard = 0;
    while (m && guard++ < 10000) {
      markers.push({ start: String(m.start.ticks), name: m.name });
      m = seq.markers.getNextMarker(m);
    }
    return { name: seq.name, video: readTracks(seq.videoTracks), audio: readTracks(seq.audioTracks), markers: markers };
  };

  ops.addMarkers = function (a) {
    var seq = findSequence(a.sequence);
    if (!seq) throw new Error("Sequence not found: " + a.sequence);
    for (var i = 0; i < a.markers.length; i++) {
      var spec = a.markers[i];
      var mk = seq.markers.createMarker(spec.seconds);
      mk.name = spec.name;
      mk.comments = spec.comment;
      if (spec.durationSeconds > 0) mk.end = spec.seconds + spec.durationSeconds;
    }
    return { added: a.markers.length };
  };

  ops.exportSequence = function (a) {
    var seq = findSequence(a.sequence);
    if (!seq) throw new Error("Sequence not found: " + a.sequence);
    // 0 = entire sequence. Synchronous; AME queueing is a later tool.
    var ok = seq.exportAsMediaDirect(a.outPath, a.presetPath, 0);
    return { ok: !!ok, outPath: a.outPath };
  };

  return {
    call: function (name, jsonArgs) {
      try {
        if (!ops.hasOwnProperty(name)) throw new Error("Unknown op: " + name);
        var args = jsonArgs ? parse(jsonArgs) : {};
        return stringify({ ok: true, result: ops[name](args) });
      } catch (e) {
        return stringify({ ok: false, error: String(e && e.message ? e.message : e), line: e && e.line ? e.line : null });
      }
    },
    _stringify: stringify
  };
})();
