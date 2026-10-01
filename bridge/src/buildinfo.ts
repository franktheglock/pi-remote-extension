import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The bridge package root. Works whether we run from `src/` (tsx) or from the
 * compiled `dist/bridge/src/`: walk up to the folder holding package.json + src/.
 */
function findRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return start;
}

/** Newest file mtime (ms) under `dir`. A `git pull` bumps it when code changes. */
export function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          newest = Math.max(newest, statSync(p).mtimeMs);
        } catch {
          /* vanished */
        }
      }
    }
  };
  walk(dir);
  return Math.floor(newest);
}

export const BRIDGE_ROOT = findRoot();

/**
 * Stamp of the source this process started from. The extension compares it with
 * the files on disk and restarts us after an update — otherwise a long-running
 * bridge keeps serving old code after `pi update`.
 */
export const CODE_STAMP = newestMtime(join(BRIDGE_ROOT, "src"));
