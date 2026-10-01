import { spawn, execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { listSessionFiles } from "./store.js";
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

export interface LaunchResult {
  ok: boolean;
  mode?: string;
  error?: string;
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

/** The pi command; overridable with PI_REMOTE_PI_CMD (e.g. an absolute path). */
function piCommand(): string {
  return process.env.PI_REMOTE_PI_CMD ?? "pi";
}

/**
 * Start a new pi session in `cwd`.
 *
 * pi is a TUI, so we open a real terminal when there's a desktop session. On a
 * headless box (or over SSH) we prefer **tmux**, which works without a display.
 * Each candidate is actually probed, and we report a real error if none work.
 */
export async function launchPi(cwd: string, resumeSessionId?: string): Promise<LaunchResult> {
  let dir = resolve(cwd && cwd.trim() ? cwd : os.homedir());
  let cmd = piCommand();

  if (resumeSessionId) {
    // Reopen a stored session. Point pi at the session file itself so the
    // lookup doesn't depend on which folder we start in.
    if (!/^[0-9a-f-]{8,64}$/i.test(resumeSessionId)) return { ok: false, error: "Invalid session id." };
    // Open in a pi that has lost its connection to us? Starting another pi on
    // the same session file would have two writers. (Live ones are caught earlier.)
    const holder = openHolder(resumeSessionId);
    if (holder) {
      return {
        ok: false,
        error: `That session is already open on this computer (pi, process ${holder}) but isn't connected. Run /reload in that pi window.`,
      };
    }
    const file = (await listSessionFiles()).find((s) => s.sessionId === resumeSessionId)?.file;
    if (!file) return { ok: false, error: "That session's file is no longer on this computer." };
    cmd += ` --session ${process.platform === "win32" ? `"${file}"` : shq(file)}`;
    // The folder the session ran in may have been moved or deleted since.
    if (!existsSync(dir)) dir = os.homedir();
  }
  const run = `cd ${shq(dir)} && exec ${cmd}`;

  if (process.platform === "darwin") {
    const script = `cd ${shq(dir)} && exec ${cmd}`;
    return trySpawn(
      "osascript",
      ["-e", `tell application "Terminal" to do script ${asq(script)}`, "-e", `tell application "Terminal" to activate`],
      {},
      "terminal"
    );
  }

  if (process.platform === "win32") {
    // Node's default argv quoting escapes inner quotes as \" which cmd.exe
    // doesn't understand ("syntax is incorrect"), so pass the command line
    // verbatim. `start /D` sets the new window's folder — no `cd` needed.
    // `"pi"` is the window title (start treats its first quoted arg as one).
    return trySpawn(
      "cmd.exe",
      ["/d", "/c", "start", `"pi"`, "/D", `"${dir}"`, "cmd.exe", "/k", cmd],
      { cwd: dir, windowsVerbatimArguments: true, windowsHide: true },
      "terminal"
    );
  }

  // Linux / other.

  // 1) tmux — works headless / over SSH. Try an existing server, else start one.
  if (hasBinary("tmux")) {
    const name = `pi-remote-${Date.now().toString(36)}`;
    const r = await trySpawn("tmux", ["new-session", "-d", "-s", name, "-c", dir, `bash -lc ${shq(`exec ${cmd}`)}`], {}, "tmux");
    if (r.ok) return r;
  }

  // 2) A graphical terminal, if a display is available.
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    const terminals: [string, string[]][] = [
      ["x-terminal-emulator", ["-e", "bash", "-lc", run]],
      ["gnome-terminal", ["--", "bash", "-lc", run]],
      ["konsole", ["-e", "bash", "-lc", run]],
      ["xfce4-terminal", ["-e", `bash -lc ${shq(run)}`]],
      ["xterm", ["-e", "bash", "-lc", run]],
    ];
    for (const [bin, args] of terminals) {
      if (hasBinary(bin)) {
        const r = await trySpawn(bin, args, {}, "terminal");
        if (r.ok) return r;
      }
    }
  }

  // 3) Detached, best effort (a TUI without a tty may not render).
  // Through a shell, since `cmd` may carry arguments (e.g. --session).
  return trySpawn("sh", ["-c", `exec ${cmd}`], { cwd: dir }, "detached");
}

/** The pid of a running pi that has marked this session open, if any. */
function openHolder(sessionId: string): number | null {
  try {
    const home = process.env.PI_REMOTE_HOME ?? join(os.homedir(), ".pi-remote");
    const pid = Number(readFileSync(join(home, "open", `${sessionId}.pid`), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0); // throws if that process is gone (stale marker)
    return pid;
  } catch {
    return null;
  }
}

function trySpawn(bin: string, args: string[], opts: any, mode: string): Promise<LaunchResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { detached: true, stdio: "ignore", ...opts });
    } catch (err) {
      resolvePromise({ ok: false, mode, error: (err as Error).message });
      return;
    }
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        resolvePromise({ ok: false, mode, error: err.message });
      }
    });
    child.unref();
    // No 'error' within a moment → treat as launched.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolvePromise({ ok: true, mode });
      }
    }, 600);
  });
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
