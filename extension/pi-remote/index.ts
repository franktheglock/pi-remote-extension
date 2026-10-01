import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Type } from "typebox";

/**
 * Pi Remote — pi extension.
 *
 * Runs inside every pi session and turns it into something the Pi Remote iPhone
 * app can discover and control:
 *
 *  • connects to the local Pi Remote bridge (`pi-remote-bridge`) and streams live
 *    status, messages, and tool activity to it;
 *  • accepts inbound commands from the app: chat (prompt / steer / followUp),
 *    abort, model switching, thinking level, rename;
 *  • emits notifications when a session COMPLETES (agent_settled) or NEEDS INPUT
 *    (a blocking UI prompt / confirmation is open);
 *  • provides the `/remote` slash command that advertises this computer (via the
 *    bridge) and prints a QR code so the iPhone app can pair in one scan.
 *
 * Install: copy `extension/pi-remote/` into `~/.pi/agent/extensions/pi-remote/`
 * and run `npm install` inside it, then start `pi-remote-bridge` once (the
 * `/remote` command will also auto-start it for you).
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BRIDGE_HTTP = process.env.PI_REMOTE_BRIDGE ?? "http://127.0.0.1:8877";
const BRIDGE_WS = BRIDGE_HTTP.replace(/^http/, "ws").replace(/\/$/, "") + "/ext";
const HEARTBEAT_MS = 15_000;
const APPEND_THROTTLE_MS = 350;

// ---------------------------------------------------------------------------
// Debug logging (best-effort; trims itself when large)
// ---------------------------------------------------------------------------

function debug(line: string): void {
  try {
    const dir = process.env.PI_REMOTE_HOME ?? `${process.env.HOME ?? "."}/.pi-remote`;
    const path = `${dir}/ext.log`;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* exists */
    }
    try {
      if (statSync(path).size > 256 * 1024) writeFileSync(path, "");
    } catch {
      /* missing */
    }
    appendFileSync(path, `[${new Date().toISOString()}] pid=${process.pid} ${line}\n`);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

let runtime: ExtensionAPI | null = null;
let runtimeCtx: ExtensionContext | null = null;

interface BridgeConn {
  ws: WebSocket | null;
  connected: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  heartbeat: NodeJS.Timeout | null;
  intentionalClose: boolean;
}

const conn: BridgeConn = {
  ws: null,
  connected: false,
  reconnectTimer: null,
  heartbeat: null,
  intentionalClose: false,
};

let currentState: RuntimeState = "starting";
let prevState: RuntimeState = "idle";
let startedAt = Date.now();
let lastAppendAt = 0;
let pendingAppend: NodeJS.Timeout | null = null;
let streamedBuffer = "";
let currentAssistantText = "";
let currentAssistantThinking = "";
const toolArgsById = new Map<string, any>();
/** Tool calls the model is still writing (not yet executing): id → what we last sent. */
const draftTools = new Map<string, { name: string; label: string; size: number; at: number }>();
let appCount = 0;
const pendingAsks = new Map<string, (answer: any) => void>();
let lastCtxCapture = "";

type RuntimeState = "starting" | "idle" | "streaming" | "waiting_input" | "compacting";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  runtime = pi;

  // ---- lifecycle ----
  pi.on("session_start", async (_event, ctx) => {
    runtimeCtx = ctx;
    startedAt = Date.now();
    setState("idle", ctx);
    connect();
  });

  // resources_discover fires on startup AND on /reload, so this guarantees the
  // extension connects even when it is loaded into an already-running session.
  pi.on("resources_discover", async (_event, ctx) => {
    if (ctx) runtimeCtx = ctx as ExtensionContext;
    connect();
    return {};
  });

  pi.on("session_shutdown", async () => {
    conn.intentionalClose = true;
    teardownSocket();
    clearSessionOpen();
  });

  pi.on("session_info_changed", async (event, ctx) => {
    pushStatus(ctx, { name: event.name });
  });

  // ---- agent activity -> streaming status + message stream ----
  pi.on("agent_start", async (_e, ctx) => {
    runtimeCtx = ctx;
    streamedBuffer = "";
    currentAssistantText = "";
    currentAssistantThinking = "";
    debug("agent_start");
    setState("streaming", ctx);
  });

  pi.on("message_update", async (event, ctx) => {
    runtimeCtx = ctx;
    const m: any = event.message;
    if (m?.role !== "assistant") return;
    streamToolCalls(m);
    // Send the FULL current assistant text + thinking; the app replaces (upserts)
    // the streaming message. Robust to any delta-event shape, and lets thinking
    // stream live even before any text is produced.
    const full = textOf(m);
    const thinking = thinkingOf(m) ?? "";
    if (full === currentAssistantText && thinking === currentAssistantThinking) return;
    currentAssistantText = full;
    currentAssistantThinking = thinking;
    streamedBuffer = full;
    scheduleAppend();
  });

  pi.on("message_end", async (event, ctx) => {
    runtimeCtx = ctx;
    const m: any = event.message;
    if (!m) return;
    debug(`message_end role=${m.role} len=${(textOf(m) || "").length}`);
    if (m.role === "assistant") {
      flushAppend();
      sendMessage({
        role: "assistant",
        text: textOf(m),
        thinking: thinkingOf(m),
        timestamp: Date.now(),
      });
      streamedBuffer = "";
      currentAssistantText = "";
      currentAssistantThinking = "";
    } else if (m.role === "user") {
      sendMessage({ role: "user", text: textOf(m), timestamp: Date.now() });
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    runtimeCtx = ctx;
    debug(`tool_start ${event.toolName}`);
    draftTools.delete(event.toolCallId);
    toolArgsById.set(event.toolCallId, event.args);
    sendMessage({
      role: "toolResult",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      toolLabel: toolLabel(event.toolName, event.args),
      toolArgs: argsDisplay(event.toolName, event.args),
      filePath: pathOf(event.args),
      toolState: "running",
      text: "",
      timestamp: Date.now(),
    });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    runtimeCtx = ctx;
    debug(`tool_end ${event.toolName} err=${!!event.isError}`);
    const args = toolArgsById.get(event.toolCallId);
    toolArgsById.delete(event.toolCallId);
    sendMessage({
      role: "toolResult",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      toolLabel: toolLabel(event.toolName, args),
      toolArgs: argsDisplay(event.toolName, args),
      filePath: pathOf(args),
      toolState: "done",
      isError: !!event.isError,
      diff: diffFor(event.toolName, args, event.result),
      text: summarizeTool(event),
      timestamp: Date.now(),
    });
  });

  // ---- completion / needs-input notifications ----
  pi.on("agent_settled", async (_e, ctx) => {
    runtimeCtx = ctx;
    debug("agent_settled");
    cancelDraftTools();
    setState("idle", ctx);
    notify("complete", "Session complete", preview(ctx) || "The agent finished and is idle.");
  });

  pi.on("ui_prompt_start", async (event, ctx) => {
    runtimeCtx = ctx;
    prevState = currentState;
    setState("waiting_input", ctx);
    const label = event.title || kindLabel(event.kind);
    notify("needs-input", "Needs your input", `${label} is waiting for a response.`);
  });

  pi.on("ui_prompt_end", async (_e, ctx) => {
    runtimeCtx = ctx;
    setState(prevState === "waiting_input" ? "idle" : prevState, ctx);
  });

  pi.on("session_compact", async (_e, ctx) => setState("idle", ctx));
  pi.on("session_before_compact", async (_e, ctx) => setState("compacting", ctx));

  // ---- remote question tool ----
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description:
      "Ask the user a question with predefined options. Delivered to the Pi Remote phone app when connected; otherwise prompts in the terminal.",
    promptSnippet: "Ask the user a multiple-choice question (reaches the Pi Remote phone app)",
    promptGuidelines: [
      "Use ask (not question) to ask the user a question when you need their input; it reaches them on the Pi Remote phone app.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask" }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "Choice label" }),
          description: Type.Optional(Type.String({ description: "Optional detail" })),
        }),
        { description: "Choices for the user" }
      ),
    }),
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) {
      const question = String(params?.question ?? "");
      const options = (params?.options ?? []) as { label: string; description?: string }[];

      if (appCount > 0) {
        const askId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const answer = await new Promise<any>((resolve) => {
          pendingAsks.set(askId, resolve);
          sendRaw({ type: "ask", sessionId: sessionId(), id: askId, question, options, allowCustom: true });
          setTimeout(() => {
            if (pendingAsks.delete(askId)) resolve(null);
          }, 10 * 60_000);
        });
        if (answer) {
          const text = answer.custom
            ? String(answer.custom)
            : answer.label ?? options[answer.index ?? -1]?.label ?? "";
          return { content: [{ type: "text", text }], details: answer };
        }
      }

      // Fallback: terminal prompt.
      const choice = await ctx.ui.select(question, options.map((o) => o.label));
      return { content: [{ type: "text", text: choice ?? "User cancelled." }], details: {} };
    },
  });

  // ---- slash command ----
  pi.registerCommand("remote", {
    description:
      "Pi Remote: advertise this computer & show a QR to pair the iPhone app. /remote [pair|status|hide|advertise on|off|token|restart]",
    handler: async (args, ctx) => {
      runtimeCtx = ctx;
      await remoteCommand(args ?? "", ctx);
    },
  });

  // Cleanup on process exit.
  process.on("exit", teardownSocket);
  process.on("exit", clearSessionOpen);
}

// ---------------------------------------------------------------------------
// WebSocket connection to the bridge
// ---------------------------------------------------------------------------

/**
 * Leave a marker saying "this pi process has this session open". The bridge
 * checks it before reopening a session from the phone, so it never starts a
 * second pi on a session that's open here but has lost its bridge connection.
 */
let openMarker: string | null = null;

function markSessionOpen(): void {
  try {
    const dir = `${process.env.PI_REMOTE_HOME ?? `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.pi-remote`}/open`;
    const path = `${dir}/${sessionId()}.pid`;
    if (path === openMarker) return;
    clearSessionOpen();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, String(process.pid));
    openMarker = path;
  } catch {
    /* best effort */
  }
}

function clearSessionOpen(): void {
  if (!openMarker) return;
  try {
    rmSync(openMarker, { force: true });
  } catch {
    /* ignore */
  }
  openMarker = null;
}

function connect(): void {
  markSessionOpen();
  if (conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  conn.intentionalClose = false;
  let ws: WebSocket;
  try {
    ws = new WebSocket(BRIDGE_WS);
  } catch {
    scheduleReconnect();
    return;
  }
  conn.ws = ws;

  ws.addEventListener("open", () => {
    conn.connected = true;
    debug(`connected ${BRIDGE_WS}`);
    // Clear the handle too: a cancelled-but-still-set timer makes
    // scheduleReconnect() think a retry is pending, so the next disconnect
    // (e.g. a bridge restart) would never be retried.
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    sendRaw({
      type: "register",
      sessionId: sessionId(),
      pid: process.pid,
      cwd: runtimeCtx?.cwd ?? process.cwd(),
      name: runtime?.getSessionName?.() ?? undefined,
      model: modelLabel(),
      startedAt,
    });
    pushStatus(runtimeCtx, {});
    startHeartbeat();
  });

  ws.addEventListener("message", (ev: MessageEvent) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg?.type === "command") {
      void handleCommand(msg);
    } else if (msg?.type === "peers") {
      appCount = typeof msg.apps === "number" ? msg.apps : 0;
    } else if (msg?.type === "answer") {
      const resolve = pendingAsks.get(msg.askId);
      if (resolve) {
        pendingAsks.delete(msg.askId);
        resolve({ index: msg.index, label: msg.label, custom: msg.custom });
      }
    } else if (msg?.type === "ping") {
      sendRaw({ type: "status", ...statusFields() });
    }
  });

  ws.addEventListener("close", () => {
    conn.connected = false;
    debug("socket closed");
    if (!conn.intentionalClose) scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    debug("socket error");
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
}

function scheduleReconnect(): void {
  if (conn.intentionalClose) return;
  if (conn.reconnectTimer) return;
  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = null;
    connect();
  }, 3000);
}

function startHeartbeat(): void {
  if (conn.heartbeat) clearInterval(conn.heartbeat);
  conn.heartbeat = setInterval(() => void heartbeatTick(), HEARTBEAT_MS);
}

async function heartbeatTick(): Promise<void> {
  if (conn.connected) sendRaw({ type: "status", ...statusFields() });
  // The socket can silently go stale (e.g. after the bridge restarts) without
  // firing a close event, so verify the bridge is actually reachable.
  try {
    const res = await fetch(`${BRIDGE_HTTP}/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch {
    debug("health check failed — reconnecting");
    const old = conn.ws;
    conn.ws = null;
    conn.connected = false;
    try {
      old?.close();
    } catch {
      /* ignore */
    }
    if (!conn.reconnectTimer) connect();
  }
}

function teardownSocket(): void {
  if (conn.heartbeat) clearInterval(conn.heartbeat);
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
  if (pendingAppend) clearTimeout(pendingAppend);
  conn.heartbeat = null;
  conn.reconnectTimer = null;
  pendingAppend = null;
  try {
    conn.ws?.close();
  } catch {
    /* ignore */
  }
  conn.ws = null;
  conn.connected = false;
}

function sendRaw(obj: unknown): void {
  if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
    try {
      conn.ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Outbound reporting helpers
// ---------------------------------------------------------------------------

function statusFields(): Record<string, unknown> {
  return {
    type: "status",
    state: currentState,
    model: modelLabel(),
    provider: (runtimeCtx?.model as any)?.provider,
    thinkingLevel: runtime?.getThinkingLevel?.() ?? runtimeCtx?.thinkingLevel,
    thinkingLevels: thinkingLevelsFor(runtimeCtx),
    isStreaming: currentState === "streaming",
    updatedAt: Date.now(),
  };
}

function pushStatus(ctx: ExtensionContext | null, extra: Record<string, unknown>): void {
  sendRaw({ ...statusFields(), ...extra });
  if (ctx && runtime?.getSessionName?.()) {
    /* name already included via modelLabel fields when present */
  }
}

function setState(
  next: RuntimeState,
  ctx?: ExtensionContext
): void {
  currentState = next;
  if (ctx) runtimeCtx = ctx;
  pushStatus(runtimeCtx ?? null, {});
}

function sendMessage(message: Record<string, unknown>): void {
  sendRaw({ type: "message", sessionId: sessionId(), message });
}

function scheduleAppend(): void {
  const now = Date.now();
  if (now - lastAppendAt >= APPEND_THROTTLE_MS) {
    flushAppend();
  } else if (!pendingAppend) {
    pendingAppend = setTimeout(() => {
      pendingAppend = null;
      flushAppend();
    }, APPEND_THROTTLE_MS);
  }
}

function flushAppend(): void {
  if (pendingAppend) {
    clearTimeout(pendingAppend);
    pendingAppend = null;
  }
  if (currentAssistantText || currentAssistantThinking) {
    sendRaw({
      type: "append",
      sessionId: sessionId(),
      text: currentAssistantText,
      thinking: currentAssistantThinking || undefined,
    });
    lastAppendAt = Date.now();
  }
}

function notify(kind: "complete" | "needs-input" | "error" | "info", title: string, body: string): void {
  sendRaw({ type: "notify", sessionId: sessionId(), kind, title, body });
}

// ---------------------------------------------------------------------------
// Inbound command handling (from the iPhone app, via the bridge)
// ---------------------------------------------------------------------------

async function handleCommand(msg: { id: string; action: string; payload?: Record<string, unknown> }): Promise<void> {
  const id = msg.id;
  const p = msg.payload ?? {};
  debug(`cmd ${msg.action}`);
  try {
    const data = await executeAction(msg.action, p);
    sendRaw({ type: "command_result", id, ok: true, data });
  } catch (err: any) {
    sendRaw({ type: "command_result", id, ok: false, error: String(err?.message ?? err) });
  }
}

async function executeAction(action: string, p: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const pi = runtime!;
  const ctx = runtimeCtx;
  switch (action) {
    case "prompt":
    case "steer":
    case "followUp": {
      const text = String(p.text ?? p.message ?? "");
      const rawImages = Array.isArray((p as any).images) ? ((p as any).images as any[]) : [];
      const images = rawImages
        .filter((im) => im && typeof im.data === "string" && im.data.length > 0)
        .map((im) => ({
          type: "image" as const,
          data: im.data,
          mimeType: typeof im.mimeType === "string" ? im.mimeType : "image/jpeg",
        }));
      if (!text && images.length === 0) throw new Error("empty message");
      const streaming = ctx ? !ctx.isIdle() : currentState === "streaming";
      let deliverAs: "steer" | "followUp" | undefined;
      if (action === "steer") deliverAs = "steer";
      else if (action === "followUp") deliverAs = "followUp";
      else if (streaming) deliverAs = (p.deliverAs as any) === "followUp" ? "followUp" : "steer";
      const content: any = images.length
        ? [...(text ? [{ type: "text", text }] : []), ...images]
        : text;
      const opts: any = { expandPromptTemplates: true };
      if (deliverAs) opts.deliverAs = deliverAs;
      await pi.sendUserMessage(content, opts);
      return { delivered: deliverAs ?? "immediate" };
    }
    case "abort": {
      ctx?.abort();
      return { ok: true };
    }
    case "setName": {
      const name = String(p.name ?? "");
      if (name) pi.setSessionName(name);
      return { name: pi.getSessionName?.() ?? name };
    }
    case "setThinkingLevel": {
      const level = String(p.level ?? "medium") as any;
      pi.setThinkingLevel(level);
      return { level: pi.getThinkingLevel?.() ?? level };
    }
    case "getAvailableThinkingLevels": {
      return { levels: thinkingLevelsFor(ctx) };
    }
    case "getAvailableModels": {
      return { models: availableModels(ctx), current: currentModelInfo(ctx) };
    }
    case "cycleModel": {
      const models = availableModels(ctx);
      if (models.length === 0) throw new Error("no models available");
      const cur = currentModelInfo(ctx);
      const idx = Math.max(0, models.findIndex((m) => m.id === cur?.id && m.provider === cur?.provider));
      const next = models[(idx + 1) % models.length];
      await applyModel(ctx, next.provider, next.id);
      return { model: next, thinkingLevel: pi.getThinkingLevel?.() };
    }
    case "setModel": {
      const provider = String(p.provider ?? "");
      const modelId = String(p.modelId ?? p.id ?? "");
      await applyModel(ctx, provider, modelId);
      return { model: currentModelInfo(ctx) };
    }
    case "getStatus": {
      return statusFields();
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

async function applyModel(ctx: ExtensionContext | null, provider: string, modelId: string): Promise<void> {
  const pi = runtime!;
  const model = ctx?.modelRegistry?.find(provider, modelId);
  if (!model) throw new Error(`model not found: ${provider}/${modelId}`);
  const ok = await pi.setModel(model as any);
  if (!ok) throw new Error(`could not set model (missing auth?): ${provider}/${modelId}`);
  pushStatus(ctx, {});
}

// ---------------------------------------------------------------------------
// Model / thinking helpers
// ---------------------------------------------------------------------------

function availableModels(ctx: ExtensionContext | null): any[] {
  try {
    const list = ctx?.modelRegistry?.getAvailable?.() ?? [];
    return list.map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: m.provider,
      reasoning: !!m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      label: `${ctx?.modelRegistry?.getProviderDisplayName?.(m.provider) ?? m.provider} / ${m.name ?? m.id}`,
    }));
  } catch {
    return [];
  }
}

function currentModelInfo(ctx: ExtensionContext | null): any | null {
  const m: any = ctx?.model;
  if (!m) return null;
  return {
    id: m.id,
    name: m.name ?? m.id,
    provider: m.provider,
    reasoning: !!m.reasoning,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    label: modelLabel(),
  };
}

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function thinkingLevelsFor(ctx: ExtensionContext | null): string[] {
  const m: any = ctx?.model;
  if (!m) return ["off", "minimal", "low", "medium", "high"];
  if (!m.reasoning) return ["off"];
  const map = m.thinkingLevelMap;
  if (map && typeof map === "object") {
    const supported = ALL_LEVELS.filter((l) => map[l] !== null && map[l] !== undefined);
    return supported.length ? supported : ["off", "low", "medium", "high"];
  }
  return ["off", "minimal", "low", "medium", "high", "xhigh"];
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

function sessionId(): string {
  // Prefer pi's real session id (from the session file) so the live session matches
  // the one discovered on disk. Falls back to the env var, then the pid.
  try {
    const f = runtimeCtx?.sessionManager?.getSessionFile?.();
    const m = f
      ? String(f).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
      : null;
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  return process.env.PI_SESSION_ID ?? `pid-${process.pid}`;
}

function modelLabel(): string {
  const m: any = runtimeCtx?.model;
  if (!m) return "";
  const provider = (m.provider ?? "") as string;
  return provider ? `${provider}/${m.id}` : String(m.id ?? "");
}

function textOf(m: any): string {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((x: any) => {
        if (typeof x === "string") return x;
        if (x?.type === "text") return x.text ?? "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return m?.text ?? "";
}

function thinkingOf(m: any): string | undefined {
  const c = m?.content;
  if (Array.isArray(c)) {
    const t = c.find((x: any) => x?.type === "thinking" || x?.type === "reasoning");
    return t?.text ?? t?.thinking;
  }
  return m?.thinking;
}

/**
 * Show a tool call as soon as the model starts writing it, instead of waiting
 * for the arguments to finish. Uses the same toolCallId as tool_execution_*,
 * so the app keeps updating one row: writing → running → done.
 */
function streamToolCalls(m: any): void {
  if (!Array.isArray(m?.content)) return;
  const now = Date.now();
  for (const block of m.content) {
    if (block?.type !== "toolCall" || typeof block.id !== "string" || !block.id || !block.name) continue;
    if (toolArgsById.has(block.id)) continue; // already executing
    const args = block.arguments && typeof block.arguments === "object" ? block.arguments : undefined;
    const hasArgs = !!args && Object.keys(args).length > 0;
    const label = toolLabel(block.name, args);
    const display = hasArgs ? argsDisplay(block.name, args) : undefined;
    const size = display?.length ?? 0;

    // Send at once when the call appears or its label changes; while the
    // arguments merely grow (e.g. a long file write), at most every 400ms.
    const prev = draftTools.get(block.id);
    if (prev && prev.label === label && (prev.size === size || now - prev.at < 400)) continue;
    draftTools.set(block.id, { name: block.name, label, size, at: now });
    sendMessage({
      role: "toolResult",
      toolName: block.name,
      toolCallId: block.id,
      toolLabel: label,
      toolArgs: display,
      filePath: pathOf(args),
      toolState: "running",
      text: "",
      timestamp: now,
    });
  }
}

/** The turn ended with calls that never ran (aborted mid-write) — stop their spinners. */
function cancelDraftTools(): void {
  for (const [id, draft] of draftTools) {
    sendMessage({
      role: "toolResult",
      toolName: draft.name,
      toolCallId: id,
      toolLabel: draft.label,
      toolState: "done",
      isError: true,
      text: "Cancelled before it ran",
      timestamp: Date.now(),
    });
  }
  draftTools.clear();
}

function extractDelta(event: any): string {
  const ev = event?.assistantMessageEvent ?? event?.event;
  if (!ev) return "";
  if (typeof ev === "string") return ev;
  if (ev.type === "text_delta" || ev.type === "delta") return ev.text ?? ev.delta ?? "";
  if (ev.type === "content_delta") return ev.delta ?? "";
  return "";
}

function summarizeTool(event: any): string {
  const r = event?.result;
  const name = event?.toolName ?? "tool";
  if (event?.isError) return `${name} failed`;
  const c = r?.content;
  if (Array.isArray(c)) {
    const t = c.find((x: any) => x?.type === "text");
    return truncate(String(t?.text ?? ""), 4000);
  }
  return `${name} done`;
}

/** A short one-line label for a tool call (command / path / query / url). */
function toolLabel(name: string, args: any): string {
  if (!args || typeof args !== "object") return name;
  if (typeof args.command === "string") return truncate(args.command.replace(/\s+/g, " ").trim(), 200);
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  if (typeof args.query === "string") return truncate(args.query, 200);
  if (typeof args.url === "string") return truncate(args.url, 200);
  if (typeof args.question === "string") return truncate(args.question, 200);
  return name;
}

function pathOf(args: any): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  return undefined;
}

/** Full tool arguments as a readable string (command for bash, pretty JSON else). */
function argsDisplay(name: string, args: any): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  if (typeof args.command === "string") return truncate(args.command, 8000);
  try {
    return truncate(JSON.stringify(args, null, 2), 8000);
  } catch {
    return undefined;
  }
}

/** Prefer pi's own diff (edit) else synthesize one (write). */
function diffFor(name: string, args: any, result: any): string | undefined {
  const d = result?.details?.diff;
  if (typeof d === "string" && d) return truncate(d, 40_000);
  if (name === "write" && args && typeof args.content === "string") {
    return truncate(
      String(args.content)
        .split("\n")
        .map((l: string) => `+${l}`)
        .join("\n"),
      40_000
    );
  }
  return undefined;
}

/** A short human preview of a tool's arguments (e.g. the shell command). */
function previewArgs(args: any): string {
  if (!args || typeof args !== "object") return "";
  if (typeof args.command === "string") return truncate(args.command, 400);
  if (typeof args.path === "string") return truncate(args.path, 400);
  if (typeof args.pattern === "string") return truncate(args.pattern, 400);
  if (typeof args.file_path === "string") return truncate(args.file_path, 400);
  try {
    return truncate(JSON.stringify(args), 400);
  } catch {
    return "";
  }
}
function preview(ctx: ExtensionContext | null): string {
  return truncate(streamedBuffer || lastCtxCapture, 120);
}

function kindLabel(kind?: string): string {
  switch (kind) {
    case "confirm":
      return "A confirmation";
    case "select":
      return "A choice";
    case "input":
      return "A text prompt";
    case "editor":
      return "An editor";
    default:
      return "A prompt";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// /remote command — advertise + pair via QR
// ---------------------------------------------------------------------------

async function remoteCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "").toLowerCase();

  if (sub === "hide") {
    ctx.ui.setWidget("pi-remote-pair", undefined);
    ctx.ui.notify("Pi Remote pairing card hidden.", "info");
    return;
  }

  if (sub === "advertise") {
    const on = (parts[1] ?? "on").toLowerCase() !== "off";
    const res = await bridgePost("/advertise", { advertise: on });
    ctx.ui.notify(res ? `Advertising ${on ? "enabled" : "disabled"}.` : "Bridge not reachable.", on ? "info" : "warning");
    return;
  }

  if (sub === "restart") {
    ctx.ui.notify("Restarting the Pi Remote bridge…", "info");
    teardownSocket();
    await stopBridge();
    const up = await ensureBridge();
    setTimeout(connect, 500);
    ctx.ui.notify(
      up ? "Pi Remote bridge restarted." : "The bridge stopped but didn't start again. Run /remote to try once more.",
      up ? "info" : "warning"
    );
    return;
  }

  // Default / status / pair / token: make sure the bridge is up and advertising.
  const up = await ensureBridge();
  const info = await fetchPairInfo();

  if (!info) {
    ctx.ui.notify(
      "Pi Remote bridge isn't reachable. Start it with: pi-remote-bridge (or `npm run dev` in the bridge folder).",
      "warning"
    );
    return;
  }

  if (sub === "token") {
    ctx.ui.notify(`Token: ${info.token}`, "info");
    return;
  }

  if (sub === "status") {
    ctx.ui.notify(
      `Pi Remote — ${info.hostname} · ${info.ips[0]?.ip ?? "?"} · port ${info.port} · advertising ${info.advertising ? "on" : "off"} · token ${info.token}`,
      "info"
    );
    return;
  }

  // Show the pairing card + QR as a persistent widget (dismiss with /remote hide).
  await showPairingWidget(ctx, info);
  ctx.ui.notify(
    `Scan this QR with the Pi Remote iPhone app (or tap "Add Computer"). Bridge ${up ? "running" : "started"}.`,
    "info"
  );
}

interface PairInfo {
  hostname: string;
  port: number;
  token: string;
  advertising: boolean;
  ips: { label: string; ip: string }[];
}

async function fetchPairInfo(): Promise<PairInfo | null> {
  try {
    const res = await fetch(`${BRIDGE_HTTP}/pair`);
    if (!res.ok) return null;
    return (await res.json()) as PairInfo;
  } catch {
    return null;
  }
}

async function bridgePost(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_HTTP}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBridge(): Promise<boolean> {
  if (await bridgeHealthy()) {
    if (!(await bridgeOutdated())) return true;
    // Our sibling bridge's code changed since that process started (e.g. after
    // `pi update`) — a running bridge never reloads, so restart it.
    await stopBridge();
  }
  const started = await startBridge();
  if (!started) return false;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    if (await bridgeHealthy()) return true;
  }
  return false;
}

async function bridgeHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_HTTP}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Where the bridge's code lives: the folder shipped next to this extension, or
 * (when the extension was copied on its own) the location the bridge recorded
 * in ~/.pi-remote/bridge-root the last time it ran.
 */
async function bridgeRoot(): Promise<string | null> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve, join } = await import("node:path");
  const { homedir } = await import("node:os");
  const sibling = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bridge");
  if (existsSync(resolve(sibling, "src"))) return sibling;
  try {
    const home = process.env.PI_REMOTE_HOME ?? join(homedir(), ".pi-remote");
    const recorded = readFileSync(join(home, "bridge-root"), "utf8").trim();
    if (recorded && existsSync(resolve(recorded, "src"))) return recorded;
  } catch {
    /* never recorded */
  }
  return null;
}

/** Newest file mtime (ms) under `dir` — mirrors bridge/src/buildinfo.ts. */
async function newestMtime(dir: string): Promise<number> {
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
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

/**
 * True when the running bridge was started from our bridge folder and that
 * folder's source has changed since. Bridges started from elsewhere
 * (PI_REMOTE_BRIDGE_BIN, npx) or too old to report a stamp are left alone.
 */
async function bridgeOutdated(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_HTTP}/health`, { signal: AbortSignal.timeout(800) });
    const health = (await res.json()) as { root?: string; codeStamp?: number };
    const root = await bridgeRoot();
    if (!root || !health.root || typeof health.codeStamp !== "number") return false;
    const same = process.platform === "win32"
      ? health.root.toLowerCase() === root.toLowerCase()
      : health.root === root;
    if (!same) return false;
    const { join } = await import("node:path");
    return (await newestMtime(join(root, "src"))) > health.codeStamp;
  } catch {
    return false;
  }
}

async function startBridge(): Promise<boolean> {
  // Spawn the bridge as a detached background process. Resolution order:
  //   PI_REMOTE_BRIDGE_BIN >
  //   <bridge root>/dist/bridge/src/index.js >
  //   <bridge root>/src/index.ts (tsx dev) >
  //   `pi-remote-bridge` on PATH >
  //   `npx --yes pi-remote-bridge`
  //
  // On Windows, npm-installed bins are `.cmd` shims that `spawn` can't execute
  // directly, so those candidates go through a shell (with quoting).
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const win = process.platform === "win32";
  const isScript = (p: string) => /\.(m?js|cjs)$/i.test(p);
  const candidates: { cmd: string; args: string[]; shell?: boolean }[] = [];

  if (process.env.PI_REMOTE_BRIDGE_BIN) {
    const bin = process.env.PI_REMOTE_BRIDGE_BIN;
    candidates.push(isScript(bin)
      ? { cmd: process.execPath, args: [bin] }
      : { cmd: bin, args: [], shell: win });
  }

  // Prefer a compiled build — but not one older than the source (dist/ is a
  // local, gitignored build that `pi update` never refreshes).
  const bridgeDir = await bridgeRoot();
  if (bridgeDir) {
    const dist = resolve(bridgeDir, "dist", "bridge", "src", "index.js");
    if (existsSync(dist) &&
        (await newestMtime(resolve(bridgeDir, "dist"))) >= (await newestMtime(resolve(bridgeDir, "src")))) {
      candidates.push({ cmd: process.execPath, args: [dist] });
    }

    const devEntry = resolve(bridgeDir, "src", "index.ts");
    if (existsSync(devEntry)) {
      const tsx = resolve(bridgeDir, "node_modules", ".bin", win ? "tsx.cmd" : "tsx");
      if (existsSync(tsx)) candidates.push({ cmd: tsx, args: [devEntry], shell: win });
      else candidates.push({ cmd: "npx", args: ["--yes", "tsx", devEntry], shell: true });
    }
  }

  candidates.push({ cmd: "pi-remote-bridge", args: [], shell: win });
  candidates.push({ cmd: "npx", args: ["--yes", "pi-remote-bridge"], shell: true });

  for (const c of candidates) {
    try {
      const options: any = { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env } };
      let child;
      if (c.shell) {
        const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
        child = spawn([c.cmd, ...c.args].map(quote).join(" "), { ...options, shell: true });
      } else {
        child = spawn(c.cmd, c.args, options);
      }
      // A missing binary is reported as an async 'error' event, not a throw.
      // Without a listener it becomes an uncaughtException and takes pi down.
      let dead = false;
      child.on("error", () => { dead = true; });
      child.on("exit", () => { dead = true; });
      child.unref();
      // Give it a few seconds to come up (tsx / npx are slow to start), but
      // move on as soon as the process is known to have failed.
      for (let i = 0; i < 16; i++) {
        await sleep(300);
        if (await bridgeHealthy()) return true;
        if (dead) break;
      }
    } catch {
      /* try next candidate */
    }
  }
  return false;
}

async function stopBridge(): Promise<void> {
  try {
    await fetch(`${BRIDGE_HTTP}/shutdown`, { method: "POST", signal: AbortSignal.timeout(3000) });
  } catch {
    /* not running, or didn't answer */
  }
  // The bridge replies before it exits, so it still looks healthy for a moment.
  // Wait until it's really gone — otherwise a restart sees a "running" bridge,
  // starts nothing, and is left with no bridge at all.
  for (let i = 0; i < 25 && (await bridgeHealthy()); i++) await sleep(200);
}

async function showPairingWidget(ctx: ExtensionCommandContext, info: PairInfo): Promise<void> {
  const host = info.ips[0]?.ip ?? "127.0.0.1";
  const payload =
    `pi-remote://connect?host=${encodeURIComponent(host)}&port=${info.port}` +
    `&token=${encodeURIComponent(info.token)}&name=${encodeURIComponent(info.hostname)}` +
    (process.env.PI_REMOTE_TLS ? "&tls=1" : "");

  const lines: string[] = [];
  lines.push(`  ┌─ Pi Remote · scan to pair ──────────────────────────┐`);
  lines.push(`  │  Computer: ${info.hostname.padEnd(41)}│`);
  lines.push(`  │  Address : ${(host + ":" + info.port).padEnd(41)}│`);
  lines.push(`  │  Token   : ${info.token.padEnd(41)}│`);
  lines.push(`  │  Network : ${info.ips.map((i) => i.ip).join(", ").slice(0, 41).padEnd(41)}│`);
  lines.push(`  └────────────────────────────────────────────────────┘`);

  // Two renderings: a solid one (preferred) and a compact one for narrow windows.
  let qrLines: string[] = [];
  let qrCompact: string[] = [];
  try {
    const QRCode: any = await import("qrcode");
    const modules = (QRCode.default ?? QRCode).create(payload, { errorCorrectionLevel: "L" }).modules;
    qrLines = renderQRSolid(modules).map((l) => "  " + l);
    qrCompact = renderQR(modules).map((l) => "  " + l);
  } catch {
    qrLines = ["  (install the 'qrcode' package in ~/.pi/agent/extensions/pi-remote to show a QR)"];
  }

  // pi cuts a string-array widget off at 10 lines, which chopped the QR in
  // half. A component isn't limited, but must keep every line within the
  // terminal width — so the text wraps and the QR is all-or-nothing.
  const visible = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").length;
  const wrap = (l: string, width: number): string[] => {
    if (visible(l) <= width) return [l];
    const out: string[] = [];
    const room = Math.max(8, width - 2);
    for (let i = 0; i < l.length; i += room) out.push((i === 0 ? "" : "  ") + l.slice(i, i + room));
    return out;
  };

  const component = {
    render(width: number): string[] {
      const out: string[] = [];
      for (const l of lines) out.push(...wrap(l, width));
      if (qrLines.every((l) => visible(l) <= width)) out.push(...qrLines);
      else if (qrCompact.length && qrCompact.every((l) => visible(l) <= width)) out.push(...qrCompact);
      else out.push(...wrap("  (Widen this window to show the QR code, or use the pairing string below.)", width));
      out.push("");
      out.push(...wrap("  Pairing string (copy if the camera is unavailable):", width));
      out.push(...wrap("  " + payload, width));
      return out;
    },
    invalidate(): void {},
  };

  ctx.ui.setWidget("pi-remote-pair", (() => component) as any, { placement: "aboveEditor" } as any);
}

/**
 * Draw a QR code from background colors alone: each module is two spaces wide
 * and one row tall. No glyphs are involved, so it stays solid in terminals
 * whose fonts or line spacing leave gaps around block characters (which makes
 * a half-block QR unreadable to a camera). Bigger than the compact form.
 */
function renderQRSolid(modules: { size: number; data: ArrayLike<number | boolean> }): string[] {
  const quiet = 2;
  const size = modules.size;
  const white = "\x1b[48;2;255;255;255m";
  const black = "\x1b[48;2;0;0;0m";
  const lines: string[] = [];
  for (let y = -quiet; y < size + quiet; y++) {
    let row = "";
    let current = "";
    for (let x = -quiet; x < size + quiet; x++) {
      const dark = x >= 0 && y >= 0 && x < size && y < size && !!modules.data[y * size + x];
      const color = dark ? black : white;
      if (color !== current) {
        row += color;
        current = color;
      }
      row += "  ";
    }
    lines.push(row + "\x1b[0m");
  }
  return lines;
}

/**
 * Compact form: half-block characters, two modules per text row, with the
 * 4-module quiet zone the QR spec asks for and explicit pure white / black.
 * Half the size of the solid form, but relies on the font drawing block
 * characters edge to edge.
 */
function renderQR(modules: { size: number; data: ArrayLike<number | boolean> }): string[] {
  const quiet = 4;
  const size = modules.size;
  const total = size + quiet * 2;
  const dark = (x: number, y: number): boolean => {
    const mx = x - quiet;
    const my = y - quiet;
    return mx >= 0 && my >= 0 && mx < size && my < size && !!modules.data[my * size + mx];
  };
  const colors = "\x1b[48;2;255;255;255m\x1b[38;2;0;0;0m";
  const lines: string[] = [];
  for (let y = 0; y < total; y += 2) {
    let row = "";
    for (let x = 0; x < total; x++) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      row += top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ";
    }
    lines.push(colors + row + "\x1b[0m");
  }
  return lines;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
