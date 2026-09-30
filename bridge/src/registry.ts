import { EventEmitter } from "node:events";
import type {
  SessionSummary,
  StoredSession,
  TranscriptMessage,
  ExtToBridge,
  SessionState,
} from "../../shared/protocol.js";
import { badgeForState } from "../../shared/protocol.js";

/** Minimal socket surface we depend on (matches `ws`). */
export interface Socket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: any[]) => void): void;
}

interface PendingCommand {
  resolve: (v: { ok: boolean; error?: string; data?: Record<string, unknown> }) => void;
  timer: NodeJS.Timeout;
}

export interface ExtClient {
  socket: Socket;
  summary: SessionSummary;
  history: TranscriptMessage[]; // ring buffer of recent messages
  pending: Map<string, PendingCommand>;
  extSessionKey: string;
}

const OPEN = 1;
const HISTORY_LIMIT = 200;
const COMMAND_TIMEOUT_MS = 20_000;

export class Registry extends EventEmitter {
  private extBySession = new Map<string, ExtClient>();
  private extBySocket = new Map<Socket, ExtClient>();
  private apps = new Set<Socket>();
  private stored: StoredSession[] = [];
  private cmdSeq = 0;

  // ---- extension side -------------------------------------------------

  addExtension(socket: Socket): void {
    socket.on("message", (raw: Buffer | string) => {
      let msg: ExtToBridge;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.handleExtMessage(socket, msg);
    });
    socket.on("close", () => this.removeExtension(socket));
    socket.on("error", () => this.removeExtension(socket));
  }

  private handleExtMessage(socket: Socket, msg: ExtToBridge): void {
    switch (msg.type) {
      case "register": {
        const key = msg.sessionId || `pid-${msg.pid}`;
        const existing = this.extBySession.get(key);
        const summary: SessionSummary = {
          sessionId: key,
          pid: msg.pid,
          cwd: msg.cwd,
          name: msg.name,
          model: msg.model,
          isStreaming: false,
          state: "starting",
          badge: "working",
          updatedAt: Date.now(),
          startedAt: msg.startedAt ?? Date.now(),
        };
        const client: ExtClient = {
          socket,
          summary,
          history: existing?.history ?? [],
          pending: new Map(),
          extSessionKey: key,
        };
        // Replace any stale connection for the same session.
        if (existing) {
          for (const [, p] of existing.pending) {
            clearTimeout(p.timer);
            p.resolve({ ok: false, error: "reconnected" });
          }
          this.extBySocket.delete(existing.socket);
        }
        this.extBySession.set(key, client);
        this.extBySocket.set(socket, client);
        this.send(socket, { type: "hello", serverVersion: "0.1.0", registered: true });
        this.markStoredLive(key);
        this.broadcastSessions();
        break;
      }
      case "status": {
        const client = this.extBySocket.get(socket);
        if (!client) return;
        Object.assign(client.summary, {
          state: msg.state,
          model: msg.model ?? client.summary.model,
          name: msg.name ?? client.summary.name,
          thinkingLevel: (msg as any).thinkingLevel ?? client.summary.thinkingLevel,
          thinkingLevels: (msg as any).thinkingLevels ?? client.summary.thinkingLevels,
          isStreaming: msg.state === "streaming",
          turnIndex: msg.turnIndex ?? client.summary.turnIndex,
          updatedAt: msg.updatedAt ?? Date.now(),
          badge: badgeForState(msg.state),
        });
        this.emit("status", client.summary);
        this.broadcast({ type: "sessionStatus", session: client.summary });
        this.broadcastSessions();
        break;
      }
      case "message": {
        const client = this.extBySocket.get(socket);
        if (!client) return;
        client.history.push(msg.message);
        if (client.history.length > HISTORY_LIMIT) client.history.splice(0, client.history.length - HISTORY_LIMIT);
        if (msg.message.text) client.summary.lastOutput = truncate(msg.message.text, 160);
        client.summary.updatedAt = Date.now();
        this.broadcast({
          type: "sessionEvent",
          sessionId: client.extSessionKey,
          event: { kind: "message", message: msg.message },
        });
        break;
      }
      case "append": {
        const client = this.extBySocket.get(socket);
        if (!client) return;
        client.summary.lastOutput = truncate(msg.text, 160);
        this.broadcast({
          type: "sessionEvent",
          sessionId: client.extSessionKey,
          event: { kind: "append", text: msg.text, thinking: msg.thinking },
        });
        break;
      }
      case "notify": {
        const client = this.extBySocket.get(socket);
        if (!client) return;
        this.broadcast({
          type: "sessionEvent",
          sessionId: client.extSessionKey,
          event: {
            kind: "notify",
            notifyKind: msg.kind,
            title: msg.title,
            body: msg.body,
          },
        });
        break;
      }
      case "command_result": {
        const client = this.extBySocket.get(socket);
        if (!client) return;
        const pending = client.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          client.pending.delete(msg.id);
          pending.resolve({ ok: msg.ok, error: msg.error, data: msg.data });
        }
        // Also forward to apps so a device awaiting a control result gets it.
        this.broadcast({
          type: "controlResult",
          sessionId: client.extSessionKey,
          id: msg.id,
          ok: msg.ok,
          error: msg.error,
          data: msg.data,
        });
        break;
      }
    }
  }

  private removeExtension(socket: Socket): void {
    const client = this.extBySocket.get(socket);
    if (!client) return;
    this.extBySocket.delete(socket);
    for (const [, p] of client.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: "extension disconnected" });
    }
    // Keep it listed but mark offline until it reconnects or disappears.
    if (this.extBySession.get(client.extSessionKey)?.socket === socket) {
      client.summary.state = "disconnected";
      client.summary.badge = "offline";
      client.summary.isStreaming = false;
      client.summary.updatedAt = Date.now();
      this.broadcast({ type: "sessionStatus", session: client.summary });
    }
    this.broadcastSessions();
  }

  /** Send a command to one session's extension and await its result. */
  sendCommand(
    sessionId: string,
    action: string,
    payload?: Record<string, unknown>
  ): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
    const client = this.extBySession.get(sessionId);
    if (!client || client.socket.readyState !== OPEN) {
      return Promise.resolve({ ok: false, error: "session not connected" });
    }
    const id = `cmd-${++this.cmdSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        client.pending.delete(id);
        resolve({ ok: false, error: "command timed out" });
      }, COMMAND_TIMEOUT_MS);
      client.pending.set(id, { resolve, timer });
      this.send(client.socket, { type: "command", id, action: action as any, payload });
    });
  }

  // ---- app side -------------------------------------------------------

  addApp(socket: Socket): void {
    this.apps.add(socket);
    socket.on("close", () => this.apps.delete(socket));
    socket.on("error", () => this.apps.delete(socket));
  }

  removeApp(socket: Socket): void {
    this.apps.delete(socket);
  }

  appCount(): number {
    return this.apps.size;
  }

  // ---- snapshots ------------------------------------------------------

  liveSessions(): SessionSummary[] {
    return [...this.extBySession.values()].map((c) => c.summary);
  }

  storedSessions(): StoredSession[] {
    return this.stored;
  }

  setStored(stored: StoredSession[]): void {
    this.stored = stored;
    this.markAllLive();
    this.broadcastSessions();
  }

  history(sessionId: string): TranscriptMessage[] {
    return this.extBySession.get(sessionId)?.history ?? [];
  }

  private markStoredLive(sessionId: string): void {
    for (const s of this.stored) {
      if (s.sessionId === sessionId) s.live = true;
    }
  }

  private markAllLive(): void {
    for (const s of this.stored) s.live = this.extBySession.has(s.sessionId);
  }

  // ---- broadcast ------------------------------------------------------

  broadcastSessions(): void {
    this.broadcast({
      type: "sessions",
      sessions: this.liveSessions(),
      stored: this.storedSessions(),
    });
  }

  broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const s of this.apps) {
      if (s.readyState === OPEN) {
        try {
          s.send(data);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private send(socket: Socket, payload: unknown): void {
    if (socket.readyState === OPEN) {
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        /* ignore */
      }
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
