import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { supportDir } from "../paths.ts";
import type { MediaInfo } from "./ffmpeg.ts";

const CHUNK = 4 * 1024 * 1024;

/**
 * Fast content checksum: size + SHA-256 of the first and last 4 MB.
 * Survives renames and moves (analyse once), costs ~8 MB of reads per file even for 100 GB footage.
 */
export function fastChecksum(path: string): string {
  const { size } = statSync(path);
  const h = createHash("sha256");
  h.update(`editz1:${size}:`);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(CHUNK, size));
    h.update(buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)));
    if (size > CHUNK) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - CHUNK), Math.max(CHUNK, size - CHUNK));
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex").slice(0, 32);
}

export interface IndexedMedia {
  checksum: string;
  path: string;
  info: MediaInfo;
}

/** Media Index: what we know about every file, keyed by content so results are reused. */
export class MediaIndex {
  private db: DatabaseSync;

  constructor(file = join(supportDir(), "media-index.sqlite")) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS paths (path TEXT PRIMARY KEY, checksum TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS media (checksum TEXT PRIMARY KEY, info TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analysis (
        checksum TEXT NOT NULL, kind TEXT NOT NULL, result TEXT NOT NULL, updated TEXT NOT NULL,
        PRIMARY KEY (checksum, kind));
      CREATE TABLE IF NOT EXISTS frame_vectors (
        checksum TEXT NOT NULL, model TEXT NOT NULL, t REAL NOT NULL, vec BLOB NOT NULL,
        PRIMARY KEY (checksum, model, t));
      CREATE TABLE IF NOT EXISTS text_vectors (model TEXT NOT NULL, text TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (model, text));
    `);
  }

  close() {
    this.db.close();
  }

  /** Checksum for a path, re-hashing only when size or mtime changed. */
  checksumFor(path: string): string {
    const st = statSync(path);
    const row = this.db.prepare("SELECT checksum, size, mtime_ms FROM paths WHERE path = ?").get(path) as
      | { checksum: string; size: number; mtime_ms: number }
      | undefined;
    if (row && row.size === st.size && row.mtime_ms === st.mtimeMs) return row.checksum;
    const checksum = fastChecksum(path);
    this.db
      .prepare("INSERT INTO paths (path, checksum, size, mtime_ms) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, size = excluded.size, mtime_ms = excluded.mtime_ms")
      .run(path, checksum, st.size, st.mtimeMs);
    return checksum;
  }

  getInfo(checksum: string): MediaInfo | undefined {
    const row = this.db.prepare("SELECT info FROM media WHERE checksum = ?").get(checksum) as { info: string } | undefined;
    return row ? JSON.parse(row.info) : undefined;
  }

  putInfo(checksum: string, info: MediaInfo) {
    this.db
      .prepare("INSERT INTO media (checksum, info, updated) VALUES (?, ?, ?) ON CONFLICT(checksum) DO UPDATE SET info = excluded.info, updated = excluded.updated")
      .run(checksum, JSON.stringify(info), new Date().toISOString());
  }

  /** `kind` includes the analysis version and parameters, e.g. "silence/v1/-35dB/0.5s". */
  getAnalysis<T>(checksum: string, kind: string): T | undefined {
    const row = this.db.prepare("SELECT result FROM analysis WHERE checksum = ? AND kind = ?").get(checksum, kind) as { result: string } | undefined;
    return row ? (JSON.parse(row.result) as T) : undefined;
  }

  putAnalysis(checksum: string, kind: string, result: unknown) {
    this.db
      .prepare("INSERT INTO analysis (checksum, kind, result, updated) VALUES (?, ?, ?, ?) ON CONFLICT(checksum, kind) DO UPDATE SET result = excluded.result, updated = excluded.updated")
      .run(checksum, kind, JSON.stringify(result), new Date().toISOString());
  }

  /** Every analysis whose kind starts with a prefix, e.g. "look/v1". */
  analysesLike<T>(kindPrefix: string): { checksum: string; kind: string; result: T }[] {
    const rows = this.db.prepare("SELECT checksum, kind, result FROM analysis WHERE substr(kind, 1, ?) = ?").all(kindPrefix.length, kindPrefix) as { checksum: string; kind: string; result: string }[];
    return rows.map((r) => ({ checksum: r.checksum, kind: r.kind, result: JSON.parse(r.result) as T }));
  }

  /** Known paths for a checksum (copies of the same file share one), newest first. */
  pathsFor(checksum: string): string[] {
    return (this.db.prepare("SELECT path FROM paths WHERE checksum = ? ORDER BY mtime_ms DESC").all(checksum) as { path: string }[]).map((r) => r.path);
  }

  /** Replace a file's frame embeddings for one model. */
  putFrameVectors(checksum: string, model: string, frames: { t: number; vec: Float32Array }[]) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM frame_vectors WHERE checksum = ? AND model = ?").run(checksum, model);
      const ins = this.db.prepare("INSERT INTO frame_vectors (checksum, model, t, vec) VALUES (?, ?, ?, ?)");
      for (const f of frames) ins.run(checksum, model, f.t, new Uint8Array(f.vec.buffer, f.vec.byteOffset, f.vec.byteLength));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Frame embeddings by checksum (all files, or one). */
  frameVectors(model: string, checksum?: string): Map<string, { t: number; vec: Float32Array }[]> {
    const rows = (
      checksum
        ? this.db.prepare("SELECT checksum, t, vec FROM frame_vectors WHERE model = ? AND checksum = ? ORDER BY t").all(model, checksum)
        : this.db.prepare("SELECT checksum, t, vec FROM frame_vectors WHERE model = ? ORDER BY checksum, t").all(model)
    ) as { checksum: string; t: number; vec: Uint8Array }[];
    const out = new Map<string, { t: number; vec: Float32Array }[]>();
    for (const r of rows) {
      const list = out.get(r.checksum) ?? [];
      list.push({ t: r.t, vec: toF32(r.vec) });
      out.set(r.checksum, list);
    }
    return out;
  }

  textVector(model: string, text: string): Float32Array | undefined {
    const row = this.db.prepare("SELECT vec FROM text_vectors WHERE model = ? AND text = ?").get(model, text) as { vec: Uint8Array } | undefined;
    return row ? toF32(row.vec) : undefined;
  }

  putTextVector(model: string, text: string, vec: Float32Array) {
    this.db
      .prepare("INSERT INTO text_vectors (model, text, vec) VALUES (?, ?, ?) ON CONFLICT(model, text) DO UPDATE SET vec = excluded.vec")
      .run(model, text, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
  }

  stats() {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return { files: n("SELECT count(*) n FROM paths"), media: n("SELECT count(*) n FROM media"), analyses: n("SELECT count(*) n FROM analysis") };
  }
}

/** BLOB → Float32Array (copied, so alignment is always right). */
function toF32(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
