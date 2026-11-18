// A small crash-safe JSON store. Every write goes to a temp file, is fsynced, then renamed over
// the target, so a crash leaves either the old file or the new one, never half of one. This is
// what makes scans resumable: each finished unit of work is saved before the next one starts.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(value, null, 1) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, "utf8");
  try { return JSON.parse(text); } catch (e) { throw new Error(`${path} is not valid JSON (${e.message}); delete it to rebuild`); }
}

/** Namespaced key/value cache rooted at `dir`. Keys become file names, so keep them simple. */
export function createStore(dir) {
  const file = (key) => {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(key)) throw new RangeError(`bad cache key ${key}`);
    return join(dir, `${key}.json`);
  };
  return {
    dir,
    get: (key, fallback) => readJson(file(key), fallback),
    put: (key, value) => writeJsonAtomic(file(key), value),
  };
}
