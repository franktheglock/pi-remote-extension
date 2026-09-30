import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { Registry } from "./registry.js";
import { discoverStored, readTranscript } from "./store.js";
import { Advertiser } from "./advertiser.js";
import { computeStats } from "./stats.js";
import { listDirs, launchPi } from "./launch.js";
import { lanAddresses, isLoopback } from "./net.js";
import { PROTOCOL_VERSION } from "../../shared/protocol.js";
import type { AppToBridge, BridgeToApp } from "../../shared/protocol.js";

export interface ServerOptions {
  host: string;
  port: number;
  token?: string;
}

function tokenPath(): string {
  return join(process.env.PI_REMOTE_HOME ?? join(os.homedir(), ".pi-remote"), "token");
}

export function loadOrCreateToken(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.PI_REMOTE_TOKEN) return process.env.PI_REMOTE_TOKEN;
  const p = tokenPath();
  try {
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
    const t = randomBytes(16).toString("hex");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, t, { mode: 0o600 });
    return t;
  } catch {
    return randomBytes(16).toString("hex");
  }
}

export async function startServer(opts: ServerOptions): Promise<{ close: () => Promise<void>; registry: Registry; advertiser: Advertiser }> {
  const token = loadOrCreateToken(opts.token);
  const registry = new Registry();
  const advertiser = new Advertiser();
  const hostname = os.hostname();
  advertiser.setTarget({ name: "Pi Remote", port: opts.port, token, hostname, ip: lanAddresses()[0]?.ip });

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttp(req, res, registry, token, advertiser, opts.port);
  });

  const extWss = new WebSocketServer({ noServer: true });
  const appWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (pathname === "/ext") {
      extWss.handleUpgrade(req, socket, head, (ws) => {
        extWss.emit("connection", ws, req);
      });
    } else if (pathname === "/app") {
      appWss.handleUpgrade(req, socket, head, (ws) => {
        appWss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  extWss.on("connection", (ws: WebSocket) => {
    registry.addExtension(ws as any);
  });

  appWss.on("connection", (ws: WebSocket) => {
    registry.addApp(ws as any);
    let authenticated = false;

    ws.on("message", async (raw: Buffer | string) => {
      let msg: AppToBridge;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (!authenticated) {
        if (msg.type === "hello" && timingSafeEqual(String(msg.token ?? ""), token)) {
          authenticated = true;
          const { hostname, platform, arch } = os;
          await refreshStored(registry);
          send(ws, {
            type: "welcome",
            host: {
              hostname: hostname(),
              platform: platform(),
              arch: arch(),
              bridgeVersion: "0.1.0",
            },
            sessions: registry.liveSessions(),
            stored: registry.storedSessions(),
          });
        } else {
          send(ws, { type: "error", message: "unauthorized", code: "auth" });
          ws.close(4401, "unauthorized");
        }
        return;
      }

      switch (msg.type) {
        case "list":
        case "subscribe":
          await refreshStored(registry);
          send(ws, {
            type: "sessions",
            sessions: registry.liveSessions(),
            stored: registry.storedSessions(),
          });
          break;
        case "stats":
          send(ws, { type: "stats", stats: await computeStats() });
          break;
        case "listDirs":
          send(ws, { type: "dirs", id: msg.id, listing: await listDirs(msg.path) });
          break;
        case "launch": {
          const res = launchPi(msg.cwd);
          send(ws, { type: "launched", id: msg.id, ok: res.ok, cwd: msg.cwd, error: res.error });
          break;
        }
        case "history": {
          // Prefer the full on-disk transcript, then append any live messages not
          // yet flushed to disk (matched by role + text since timestamps differ).
          const { messages: disk } = await readTranscript(msg.sessionId, msg.limit ?? 300);
          const live = registry.history(msg.sessionId);
          const key = (m: any) => m.toolCallId ? `tool|${m.toolCallId}` : `${m.role}|${(m.text ?? "").slice(0, 80)}`;
          const seen = new Set(disk.map(key));
          const extra = live.filter((m: any) => !seen.has(key(m)));
          send(ws, { type: "history", sessionId: msg.sessionId, messages: [...disk, ...extra] });
          break;
        }
        case "control": {
          const result = await registry.sendCommand(msg.sessionId, msg.action, msg.payload);
          send(ws, {
            type: "controlResult",
            sessionId: msg.sessionId,
            id: String((msg as any).id ?? `${msg.action}`),
            ok: result.ok,
            error: result.error,
            data: result.data,
          });
          break;
        }
        case "disconnect":
          ws.close(1000, "bye");
          break;
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => resolve());
  }).catch((err) => {
    console.error(`Failed to listen on ${opts.host}:${opts.port}:`, (err as Error)?.message ?? err);
    process.exit(1);
  });

  // Periodically refresh on-disk session list so the app sees new/renamed sessions.
  const refreshTimer = setInterval(() => void refreshStored(registry), 15_000);
  void refreshStored(registry);

  return {
    registry,
    advertiser,
    close: async () => {
      clearInterval(refreshTimer);
      advertiser.stop();
      extWss.close();
      appWss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function refreshStored(registry: Registry): Promise<void> {
  try {
    const stored = await discoverStored();
    registry.setStored(stored);
  } catch {
    /* ignore */
  }
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  registry: Registry,
  token: string,
  advertiser: Advertiser,
  port: number
): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-PI-Remote-Token");

  const loopback = isLoopback(req.socket.remoteAddress);

  if (pathname === "/health") {
    return json(res, 200, {
      ok: true,
      version: "0.1.0",
      protocol: PROTOCOL_VERSION,
      hostname: os.hostname(),
      port,
      advertising: advertiser.enabled,
      ips: lanAddresses(),
    });
  }

  // Pairing info exposes the token — loopback only (the extension calls it locally).
  if (pathname === "/pair") {
    if (!loopback) return json(res, 403, { error: "pairing info is loopback-only" });
    return json(res, 200, {
      hostname: os.hostname(),
      port,
      token,
      advertising: advertiser.enabled,
      ips: lanAddresses(),
    });
  }

  if (pathname === "/advertise" && req.method === "POST") {
    if (!loopback) return json(res, 403, { error: "loopback-only" });
    const body = await readBody(req);
    let enable = !advertiser.enabled;
    try {
      const parsed = JSON.parse(body || "{}");
      if (typeof parsed.advertise === "boolean") enable = parsed.advertise;
    } catch {
      /* default toggle */
    }
    if (enable) advertiser.enable();
    else advertiser.disable();
    return json(res, 200, { advertising: advertiser.enabled });
  }

  if (pathname === "/shutdown" && req.method === "POST") {
    if (!loopback) return json(res, 403, { error: "loopback-only" });
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 100);
    return;
  }

  const authed =
    timingSafeEqual(String(req.headers["x-pi-remote-token"] ?? ""), token) ||
    timingSafeEqual(String(new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? ""), token);

  if (!authed) return json(res, 401, { error: "unauthorized" });

  if (pathname === "/sessions") {
    await refreshStored(registry);
    return json(res, 200, {
      sessions: registry.liveSessions(),
      stored: registry.storedSessions(),
    });
  }

  if (pathname === "/token-check") {
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "not found" });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(data);
}

function send(ws: WebSocket, payload: BridgeToApp | Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
