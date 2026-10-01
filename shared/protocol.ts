/**
 * Pi Remote — shared wire protocol.
 *
 * This file is the single source of truth for every message exchanged between:
 *   - the pi extension (runs inside each pi session)  <->  the bridge daemon
 *   - the SwiftUI app                                 <->  the bridge daemon
 *
 * Keep the Swift mirror in `app/PiRemote/Core/Protocol.swift` in sync.
 */

/** The lifecycle of one pi session, as observed by the extension. */
export type SessionState =
  | "starting"      // session_start fired, agent not yet doing anything
  | "idle"          // ready for user input (agent_settled / not streaming)
  | "streaming"     // an agent run is in progress
  | "waiting_input" // a blocking UI prompt is open (select/confirm/input/editor/custom)
  | "compacting"    // context compaction in progress
  | "disconnected"; // extension lost its bridge connection (best-effort)

/** Coarse status the app shows as a badge. */
export type SessionBadge = "working" | "needs-input" | "done" | "offline";

/** A model selectable in a session (mirrors pi's Model). */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
  label: string; // "Provider / Name"
}

export interface SessionSummary {
  sessionId: string;          // pi session id (uuid) when available
  pid: number;                // OS pid of the pi process
  cwd: string;                // working directory
  name?: string;              // display name from /name or pi.setSessionName()
  model?: string;             // "provider/model" label
  provider?: string;
  thinkingLevel?: string;     // off|minimal|low|medium|high|xhigh|max
  isStreaming: boolean;
  state: SessionState;
  badge: SessionBadge;
  updatedAt: number;          // epoch ms of last state change
  startedAt: number;          // epoch ms the extension registered
  lastOutput?: string;        // short preview of the most recent assistant text
  turnIndex?: number;
  availableModels?: ModelInfo[];   // populated on demand via getAvailableModels
  thinkingLevels?: string[];       // populated on demand
}

/** A session that exists on disk but has no live extension attached. */
export interface StoredSession {
  sessionId: string;
  name?: string;
  cwd: string;
  updatedAt: number;
  messageCount: number;
  live: boolean; // true if a live extension is currently attached
}

/** One message in a session transcript (trimmed for transport). */
export interface TranscriptMessage {
  role: "user" | "assistant" | "system" | "toolResult";
  text: string;         // plain text rendering (assistant text, user text, tool summary)
  thinking?: string;    // assistant thinking, when present
  timestamp?: number;
  isStreaming?: boolean;
  toolName?: string;    // for toolResult / tool activity rows
  toolCallId?: string;  // correlates a tool call's start & end
  toolLabel?: string;   // primary detail: command / path / query / url
  toolArgs?: string;    // full arguments (pretty JSON or the command)
  filePath?: string;    // full path for edit/write/read
  diff?: string;        // unified diff (edit/write) when available
  isError?: boolean;
  toolState?: "running" | "done";
}

// ---------------------------------------------------------------------------
// Extension  ->  Bridge
// ---------------------------------------------------------------------------

export type ExtToBridge =
  | {
      type: "register";
      sessionId: string;
      pid: number;
      cwd: string;
      name?: string;
      model?: string;
      startedAt: number;
    }
  | {
      type: "status";
      state: SessionState;
      model?: string;
      name?: string;
      thinkingLevel?: string;
      thinkingLevels?: string[];
      turnIndex?: number;
      updatedAt: number;
    }
  | {
      type: "message";
      sessionId: string;
      message: TranscriptMessage;
    }
  | {
      type: "append"; // full current assistant text (+ thinking) for the streaming message
      sessionId: string;
      text: string;
      thinking?: string;
    }
  | {
      type: "notify"; // high-level event the app turns into a local notification
      sessionId: string;
      kind: "complete" | "needs-input" | "error" | "info";
      title: string;
      body: string;
    }
  | {
      type: "ask"; // a question the app can ANSWER (from the `ask` tool)
      sessionId: string;
      id: string;
      question: string;
      options: { label: string; description?: string }[];
      allowCustom?: boolean;
    }
  | {
      type: "command_result";
      id: string;
      ok: boolean;
      error?: string;
      data?: Record<string, unknown>; // e.g. { models: ModelInfo[] }, { levels: string[] }
    };

// ---------------------------------------------------------------------------
// Bridge  ->  Extension
// ---------------------------------------------------------------------------

export type BridgeToExt =
  | { type: "hello"; serverVersion: string; registered: boolean }
  | { type: "peers"; apps: number }
  | { type: "answer"; askId: string; index?: number; label?: string; custom?: string }
  | {
      type: "command";
      id: string;
      action: ExtCommandAction;
      payload?: Record<string, unknown>;
    }
  | { type: "ping"; ts: number };

export type ExtCommandAction =
  | "prompt"       // send a user message (may need deliverAs when streaming)
  | "steer"        // queue steering message
  | "followUp"     // queue follow-up message
  | "abort"        // abort current run
  | "setName"      // pi.setSessionName()
  | "setThinkingLevel"
  | "getAvailableThinkingLevels"
  | "getAvailableModels"   // returns { models: ModelInfo[] }
  | "cycleModel"
  | "setModel"            // payload { provider, modelId }
  | "getStatus";   // ask for a fresh status push

// ---------------------------------------------------------------------------
// App  <->  Bridge
// ---------------------------------------------------------------------------

export type AppToBridge =
  | { type: "hello"; token: string; appVersion: string; deviceId?: string }
  | { type: "list" }                                  // request full snapshot
  | { type: "stats" }                                 // request usage stats
  | {
      type: "answer"; // answer a pending `ask`
      sessionId: string;
      id: string;
      index?: number;
      label?: string;
      custom?: string;
    }
  | { type: "listDirs"; id: string; path?: string }    // browse the filesystem
  // Start pi in `cwd`. With `sessionId`, reopen that stored session instead of a new one.
  | { type: "launch"; id: string; cwd: string; sessionId?: string }
  | { type: "subscribe" }                             // request live updates
  | { type: "history"; sessionId: string; limit?: number }
  | {
      type: "control";
      sessionId: string;
      action: ExtCommandAction;
      payload?: Record<string, unknown>;
    }
  | { type: "disconnect" };

export type BridgeToApp =
  | {
      type: "welcome";
      host: {
        hostname: string;
        platform: string;
        arch: string;
        bridgeVersion: string;
      };
      sessions: SessionSummary[];
      stored: StoredSession[];
    }
  | { type: "sessions"; sessions: SessionSummary[]; stored: StoredSession[] }
  | { type: "sessionStatus"; session: SessionSummary }
  | {
      type: "sessionEvent";
      sessionId: string;
      event:
        | { kind: "append"; text: string; thinking?: string }
        | { kind: "message"; message: TranscriptMessage }
        | { kind: "notify"; notifyKind: "complete" | "needs-input" | "error" | "info"; title: string; body: string };
    }
  | { type: "history"; sessionId: string; messages: TranscriptMessage[] }
  | { type: "stats"; stats: StatsPayload }
  | { type: "dirs"; id: string; listing: DirListing }
  | { type: "launched"; id: string; ok: boolean; cwd: string; mode?: string; error?: string }
  | {
      type: "ask";
      sessionId: string;
      id: string;
      question: string;
      options: { label: string; description?: string }[];
      allowCustom?: boolean;
    }
  | {
      // result of a `control` command, forwarded back to the requesting app
      type: "controlResult";
      sessionId: string;
      id: string;
      ok: boolean;
      error?: string;
      data?: Record<string, unknown>;
    }
  | { type: "error"; message: string; code?: string }
  | { type: "pong"; ts: number };

/** Aggregate token / cost / model usage across all local sessions. */
export interface ModelUsage {
  provider: string;
  model: string;
  tokens: number;
  cost: number;
  messages: number;
}

export interface PeriodStats {
  tokens: number;
  cost: number;
  messages: number;
  models: ModelUsage[];
  topModel?: ModelUsage;
}

export interface StatsPayload {
  totals: { tokens: number; cost: number; messages: number; sessions: number; models: ModelUsage[] };
  periods: { today: PeriodStats; week: PeriodStats; month: PeriodStats; year: PeriodStats };
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Filesystem browsing / launching
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function badgeForState(state: SessionState): SessionBadge {
  switch (state) {
    case "streaming":
      return "working";
    case "waiting_input":
      return "needs-input";
    case "idle":
      return "done";
    case "starting":
    case "compacting":
      return "working";
    case "disconnected":
      return "offline";
    default:
      return "offline";
  }
}

export const PROTOCOL_VERSION = 1;
