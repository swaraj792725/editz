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

  stats() {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return { files: n("SELECT count(*) n FROM paths"), media: n("SELECT count(*) n FROM media"), analyses: n("SELECT count(*) n FROM analysis") };
  }
}
