// Model Usage Tracker — records per-turn model/token usage to a JSONL log.
//
// Built against the real SDK contract (src/plugins/hook-types.ts):
//  - llm_output event: { runId, sessionId, provider, model, contextTokenBudget?,
//      usage?: { input?, output?, cacheRead?, cacheWrite?, total? }, reasoningEffort?, fastMode? }
//    Fires per model call; the reliable source. Accumulated per runId.
//  - agent_end event: { runId?, success, durationMs? } — the clean turn boundary; flushes the row.
//
// Output: one JSONL row per turn appended to the usage log. Each row is a
// projection of what actually happened — never an estimate.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

// Resolve the workspace once, from a stable anchor — NOT process.cwd() (the
// gateway runs from $HOME, which silently wrote the log to ~/memory). This file
// lives at <workspace>/openclaw/extensions/model-usage-tracker/index.ts, so the
// workspace is three directories up.
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = resolve(PLUGIN_DIR, "..", "..", "..");

type UsageRow = {
  ts: string;
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  contextTokenBudget?: number;
  reasoningEffort?: string;
  fastMode?: boolean;
  calls: number;
  durationMs?: number;
  source: "llm_output";
  flushedVia?: string;
};

type LlmUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type LlmOutputEvent = {
  runId?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  contextTokenBudget?: number;
  usage?: LlmUsage;
  reasoningEffort?: string;
  fastMode?: boolean;
};

type AgentEndEvent = { runId?: string; success?: boolean; durationMs?: number };

type AgentContext = {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
};

// In-flight accumulation keyed by runId. Flushed on agent_end, swept after TTL.
const inflight = new Map<string, UsageRow>();
const FLUSH_TTL_MS = 15 * 60 * 1000;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export default definePluginEntry({
  id: "model-usage-tracker",
  name: "Model Usage Tracker",
  description: "Per-turn model/token usage recording for the cost curve.",
  register(api: OpenClawPluginApi) {
    const logFor = (ctx: AgentContext): string => {
      const cfg = (api.pluginConfig ?? {}) as { logPath?: string };
      if (str(cfg.logPath)) {
        return cfg.logPath as string;
      }
      const workspaceDir =
        str(ctx.workspaceDir) ?? process.env.OPENCLAW_WORKSPACE_DIR ?? WORKSPACE_DIR;
      return `${workspaceDir.replace(/\/$/, "")}/memory/model-usage.jsonl`;
    };

    const write = async (row: UsageRow, logPath: string): Promise<void> => {
      const cfg = (api.pluginConfig ?? {}) as { enabled?: boolean };
      if (cfg.enabled === false) {
        return;
      }
      try {
        await mkdir(dirname(logPath), { recursive: true });
        await appendFile(logPath, `${JSON.stringify(row)}\n`, "utf8");
      } catch (err) {
        api.runtime?.log?.warn?.(`[model-usage-tracker] write failed: ${String(err)}`);
      }
    };

    const sweep = (logPath: string): void => {
      const now = Date.now();
      for (const [runId, row] of inflight) {
        if (now - Date.parse(row.ts) > FLUSH_TTL_MS) {
          inflight.delete(runId);
          void write(row, logPath);
        }
      }
    };

    // Per model call — accumulate token usage for the turn (keyed by runId).
    api.on("llm_output", (event: LlmOutputEvent, ctx: AgentContext) => {
      try {
        const runId = str(event.runId) ?? str(ctx.runId) ?? "unknown";
        const u = event.usage ?? {};
        const logPath = logFor(ctx);
        let row = inflight.get(runId);
        if (!row) {
          row = {
            ts: new Date().toISOString(),
            runId,
            sessionId: str(event.sessionId) ?? str(ctx.sessionId),
            sessionKey: str(ctx.sessionKey),
            model: str(event.model),
            provider: str(event.provider),
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            contextTokenBudget: event.contextTokenBudget,
            reasoningEffort: str(event.reasoningEffort),
            fastMode: typeof event.fastMode === "boolean" ? event.fastMode : undefined,
            calls: 0,
            source: "llm_output",
          };
          inflight.set(runId, row);
        }
        row.calls += 1;
        row.inputTokens += num(u.input);
        row.outputTokens += num(u.output);
        row.cacheReadTokens += num(u.cacheRead);
        row.cacheWriteTokens += num(u.cacheWrite);
        row.totalTokens += num(u.total) || num(u.input) + num(u.output);
        if (event.contextTokenBudget !== undefined) {
          row.contextTokenBudget = event.contextTokenBudget;
        }
        if (str(event.model)) {
          row.model = str(event.model);
        }
        sweep(logPath);
      } catch (err) {
        api.runtime?.log?.warn?.(`[model-usage-tracker] llm_output error: ${String(err)}`);
      }
    });

    // Flush the accumulated row for a turn. Idempotent: first end-signal wins,
    // the row is deleted so a second signal (agent_end vs reply_payload_sending)
    // can't double-write.
    const flush = async (
      runId: string,
      logPath: string,
      via: string,
      durationMs?: number,
    ): Promise<void> => {
      const row = inflight.get(runId);
      if (!row) {
        return;
      }
      inflight.delete(runId);
      if (durationMs !== undefined) {
        row.durationMs = durationMs;
      }
      row.source = "llm_output";
      row.flushedVia = via;
      await write(row, logPath);
    };

    // Primary end-of-turn signal on the embedded runtime: fires on every reply.
    api.on("reply_payload_sending", async (event: unknown, ctx: AgentContext) => {
      try {
        const runId = str(ctx.runId) ?? str((event as { runId?: unknown })?.runId) ?? "unknown";
        await flush(runId, logFor(ctx), "reply_payload_sending");
      } catch (err) {
        api.runtime?.log?.warn?.(
          `[model-usage-tracker] reply_payload_sending error: ${String(err)}`,
        );
      }
    });

    // Secondary signal (when present): also flushes, idempotently.
    api.on("agent_end", async (event: AgentEndEvent, ctx: AgentContext) => {
      try {
        const runId = str(event.runId) ?? str(ctx.runId) ?? "unknown";
        const durationMs = typeof event.durationMs === "number" ? event.durationMs : undefined;
        await flush(runId, logFor(ctx), "agent_end", durationMs);
      } catch (err) {
        api.runtime?.log?.warn?.(`[model-usage-tracker] agent_end error: ${String(err)}`);
      }
    });
  },
});
