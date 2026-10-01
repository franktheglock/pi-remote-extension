import { readFile } from "node:fs/promises";
import { listSessionFiles } from "./store.js";

// The wire types live in shared/protocol.ts (the app decodes the same shapes).
import type { ModelUsage, PeriodStats, StatsPayload } from "../../shared/protocol.js";
export type { ModelUsage, PeriodStats, StatsPayload };

interface Acc {
  tokens: number;
  cost: number;
  messages: number;
  models: Map<string, ModelUsage>;
}

function newAcc(): Acc {
  return { tokens: 0, cost: 0, messages: 0, models: new Map() };
}

function addTo(acc: Acc, provider: string, model: string, tokens: number, cost: number): void {
  acc.tokens += tokens;
  acc.cost += cost;
  acc.messages += 1;
  const key = `${provider}/${model}`;
  const m = acc.models.get(key) ?? { provider, model, tokens: 0, cost: 0, messages: 0 };
  m.tokens += tokens;
  m.cost += cost;
  m.messages += 1;
  acc.models.set(key, m);
}

function topModel(acc: Acc): ModelUsage | undefined {
  return sortedModels(acc)[0];
}

function sortedModels(acc: Acc): ModelUsage[] {
  return [...acc.models.values()].sort((a, b) => b.tokens - a.tokens);
}

function toPeriod(acc: Acc): PeriodStats {
  const models = sortedModels(acc);
  return { tokens: acc.tokens, cost: acc.cost, messages: acc.messages, models, topModel: models[0] };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

let cache: { at: number; data: StatsPayload } | null = null;

/** Aggregate token/cost/model usage across all local sessions (cached briefly). */
export async function computeStats(ttlMs = 60_000): Promise<StatsPayload> {
  if (cache && Date.now() - cache.at < ttlMs) return cache.data;

  const files = await listSessionFiles();
  const now = Date.now();
  const today = startOfDay(now);
  const week = today - 6 * 86_400_000;
  const month = (() => {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  })();
  const year = new Date(new Date(now).getFullYear(), 0, 1).getTime();

  const all = newAcc();
  const accToday = newAcc();
  const accWeek = newAcc();
  const accMonth = newAcc();
  const accYear = newAcc();

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file.file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type !== "message") continue;
      const m = obj.message;
      if (!m || m.role !== "assistant" || !m.usage) continue;

      const u = m.usage;
      const tokens =
        num(u.totalTokens) || num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
      const cost = num(u.cost?.total);
      const provider = typeof m.provider === "string" ? m.provider : "unknown";
      const model = typeof m.model === "string" ? m.model : "unknown";

      addTo(all, provider, model, tokens, cost);

      const rawTs = m.timestamp ?? obj.timestamp;
      const ts = typeof rawTs === "number" ? rawTs : Date.parse(typeof rawTs === "string" ? rawTs : "");
      if (Number.isFinite(ts)) {
        if (ts >= today) addTo(accToday, provider, model, tokens, cost);
        if (ts >= week) addTo(accWeek, provider, model, tokens, cost);
        if (ts >= month) addTo(accMonth, provider, model, tokens, cost);
        if (ts >= year) addTo(accYear, provider, model, tokens, cost);
      }
    }
  }

  const data: StatsPayload = {
    totals: {
      tokens: all.tokens,
      cost: all.cost,
      messages: all.messages,
      sessions: files.length,
      models: sortedModels(all),
    },
    periods: {
      today: toPeriod(accToday),
      week: toPeriod(accWeek),
      month: toPeriod(accMonth),
      year: toPeriod(accYear),
    },
    generatedAt: Date.now(),
  };
  cache = { at: Date.now(), data };
  return data;
}
