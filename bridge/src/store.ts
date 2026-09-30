import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import os from "node:os";
import type { StoredSession } from "../../shared/protocol.js";

/** Default pi session root. Override with PI_SESSION_DIR. */
export function sessionRoot(): string {
  return process.env.PI_SESSION_DIR ?? join(os.homedir(), ".pi", "agent", "sessions");
}

interface RawSession {
  file: string;
  sessionId: string;
  mtimeMs: number;
}

function sessionIdFromName(file: string): string | null {
  // Filenames look like: 2026-09-29T20-03-30-969Z_01a0eec3-....jsonl
  const m = basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}

async function walk(dir: string, out: RawSession[], depth = 0): Promise<void> {
  if (depth > 4) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, out, depth + 1);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      const sid = sessionIdFromName(e.name);
      if (!sid) continue;
      try {
        const s = await stat(p);
        out.push({ file: p, sessionId: sid, mtimeMs: s.mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }
}

/** Read just enough of a session file to describe it in a list. */
async function describe(file: string, sessionId: string, mtimeMs: number): Promise<StoredSession> {
  let cwd = "";
  let name: string | undefined;
  let messageCount = 0;
  try {
    const fh = await import("node:fs/promises").then((fs) => fs.open(file, "r"));
    try {
      const { buffer, bytesRead } = await fh.read({ buffer: Buffer.alloc(64 * 1024), length: 64 * 1024, position: 0 });
      const head = buffer.subarray(0, bytesRead).toString("utf8");
      const lines = head.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        messageCount++;
        try {
          const obj = JSON.parse(line);
          if (obj?.type === "session") {
            cwd = obj.cwd ?? "";
            name = obj.name ?? obj.sessionName ?? undefined;
          } else if (obj?.type === "session_info" && obj.name) {
            name = obj.name;
          }
        } catch {
          /* partial line at buffer edge; ignore */
        }
      }
    } finally {
      await fh.close();
    }
  } catch {
    /* ignore */
  }
  return {
    sessionId,
    name,
    cwd: cwd || decodeFolderName(dirname(file)),
    updatedAt: Math.round(mtimeMs),
    messageCount,
    live: false,
  };
}

/** pi folder-names encode the cwd, e.g. --Users-claymcgranahan-Documents-pi remote-- */
function decodeFolderName(dir: string): string {
  const b = basename(dir);
  if (!b.startsWith("--")) return "";
  return b.slice(2).replace(/--$/, "").replace(/-/g, "/");
}

/** Return every session file on disk (path + id + mtime). */
export async function listSessionFiles(): Promise<RawSession[]> {
  const raw: RawSession[] = [];
  await walk(sessionRoot(), raw);
  return raw;
}

/** Return the newest stored sessions across all projects. */
export async function discoverStored(limit = 200): Promise<StoredSession[]> {
  const raw: RawSession[] = [];
  await walk(sessionRoot(), raw);
  raw.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = raw.slice(0, limit);
  const results = await Promise.all(top.map((r) => describe(r.file, r.sessionId, r.mtimeMs)));
  return results;
}

/** Read a full transcript for one session, newest last. */
export async function readTranscript(
  sessionId: string,
  limit = 200
): Promise<{ messages: any[]; meta: { cwd?: string; name?: string } }> {
  const raw: RawSession[] = [];
  await walk(sessionRoot(), raw);
  const match = raw.find((r) => r.sessionId === sessionId);
  if (!match) return { messages: [], meta: {} };
  const text = await readFile(match.file, "utf8");
  const messages: any[] = [];
  const toolArgsById = new Map<string, string>();
  let meta: { cwd?: string; name?: string } = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === "session") {
      meta = { cwd: obj.cwd, name: obj.name ?? obj.sessionName };
      continue;
    }
    collectToolArgs(obj, toolArgsById);
    const mapped = entryToTranscript(obj, toolArgsById);
    if (mapped) messages.push(mapped);
  }
  return { messages: messages.slice(-limit), meta };
}

/** Record tool-call arguments keyed by toolCallId (assistant entries precede results). */
function collectToolArgs(obj: any, map: Map<string, string>): void {
  if (obj?.type !== "message") return;
  const m = obj.message;
  if (m?.role !== "assistant" || !Array.isArray(m.content)) return;
  for (const part of m.content) {
    if ((part?.type === "toolCall" || part?.type === "toolUse" || part?.type === "tool_use") && typeof part.id === "string") {
      const args = part.arguments ?? part.input ?? part.args;
      let display: string | undefined;
      if (args && typeof args === "object" && typeof args.command === "string") display = args.command;
      else if (args !== undefined) {
        try {
          display = JSON.stringify(args, null, 2);
        } catch {
          display = undefined;
        }
      }
      if (display) map.set(part.id, display.length > 8000 ? display.slice(0, 8000) : display);
    }
  }
}

/** Map a pi session entry to a transport TranscriptMessage (best-effort). */
export function entryToTranscript(obj: any, toolArgsById?: Map<string, string>): any | null {
  if (!obj) return null;

  // pi session entries look like: { type: "message", id, parentId, timestamp, message: {...} }
  const m = obj.type === "message" ? obj.message : obj;
  if (!m) return null;

  const role = m.role;
  if (role !== "assistant" && role !== "user" && role !== "system" && role !== "toolResult") {
    return null;
  }

  const tsRaw = m.timestamp ?? obj.timestamp;
  const ts = typeof tsRaw === "number" ? tsRaw : Date.parse(typeof tsRaw === "string" ? tsRaw : "");

  return {
    role,
    text: extractText(m.content),
    thinking: extractThinking(m.content),
    timestamp: Number.isFinite(ts) ? ts : undefined,
    toolName: m.toolName,
    toolCallId: m.toolCallId,
    toolArgs: m.toolCallId ? toolArgsById?.get(m.toolCallId) : undefined,
    filePath: typeof m.path === "string" ? m.path : undefined,
    diff: typeof m.details?.diff === "string" ? m.details.diff : undefined,
    isError: m.isError,
    toolState: role === "toolResult" ? "done" : undefined,
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (typeof c === "string") return c;
        if (c?.type === "text") return c.text ?? "";
        // Tool calls are shown as their own tool rows, so don't inline them as text.
        if (c?.type === "toolUse" || c?.type === "tool_use" || c?.type === "toolCall") return "";
        return ""; // thinking/reasoning handled separately
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    return (content as any).text ?? "";
  }
  return "";
}

function extractThinking(content: unknown): string | undefined {
  if (Array.isArray(content)) {
    const t = content.find((c: any) => c?.type === "thinking" || c?.type === "reasoning");
    const text = t?.thinking ?? t?.text ?? t?.reasoning;
    return text || undefined;
  }
  return undefined;
}
