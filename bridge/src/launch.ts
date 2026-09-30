import { spawn, execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import os from "node:os";

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  dirs: DirEntry[];
}

/** List subdirectories of `input` (defaults to $HOME) for the folder picker. */
export async function listDirs(input?: string): Promise<DirListing> {
  const home = os.homedir();
  let target = input && input.trim() ? resolve(input) : home;
  try {
    const s = await stat(target);
    if (!s.isDirectory()) target = dirname(target);
  } catch {
    target = home;
  }

  let dirs: DirEntry[] = [];
  try {
    const entries = await readdir(target, { withFileTypes: true });
    dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: join(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    /* permission denied etc. */
  }

  const parent = dirname(target) === target ? null : dirname(target);
  return { path: target, parent, home, dirs };
}

/** Where the pi binary lives; overridable with PI_REMOTE_PI_CMD. */
function piCommand(): string {
  return process.env.PI_REMOTE_PI_CMD ?? "pi";
}

/**
 * Start a new pi session in `cwd`. On a desktop we open a real terminal window
 * (pi is a TUI); otherwise we fall back to tmux / a detached process. Best-effort.
 */
export function launchPi(cwd: string): { ok: boolean; error?: string } {
  const dir = resolve(cwd && cwd.trim() ? cwd : os.homedir());
  const cmd = piCommand();

  try {
    if (process.platform === "darwin") {
      const script = `cd ${shq(dir)} && exec ${cmd}`;
      spawn("osascript", ["-e", `tell application "Terminal" to do script ${asq(script)}`, "-e", `tell application "Terminal" to activate`], {
        detached: true,
        stdio: "ignore",
      }).unref();
      return { ok: true };
    }

    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", "cmd", "/k", `cd /d "${dir}" && ${cmd}`], {
        detached: true,
        stdio: "ignore",
      }).unref();
      return { ok: true };
    }

    // Linux / other: prefer a graphical terminal, else tmux, else detached.
    const inner = `cd ${shq(dir)} && exec ${cmd}`;
    const terminals: [string, string[]][] = [
      ["x-terminal-emulator", ["-e", "bash", "-lc", inner]],
      ["gnome-terminal", ["--", "bash", "-lc", inner]],
      ["konsole", ["-e", "bash", "-lc", inner]],
      ["xterm", ["-e", "bash", "-lc", inner]],
    ];
    for (const [bin, args] of terminals) {
      if (hasBinary(bin)) {
        spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
        return { ok: true };
      }
    }
    if (hasBinary("tmux")) {
      spawn("tmux", ["new-session", "-d", "-c", dir, cmd], { detached: true, stdio: "ignore" }).unref();
      return { ok: true };
    }
    spawn(cmd, [], { cwd: dir, detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function hasBinary(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function asq(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
