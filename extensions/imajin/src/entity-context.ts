/**
 * Entity context decorator for the Imajin plugin.
 *
 * Hook: before_prompt_build
 *
 * Scans the latest user message for @handle mentions, resolves each via the
 * Imajin identity graph, and prepends a short context block to the turn so
 * the model knows who is being referenced before it tries to answer.
 *
 * Failure modes are silent — a network blip should never block the agent.
 *
 * Refs: #846 (item 3).
 */

import type { ImajinClient, ImajinIdentity } from "./client.js";

// Handle: leading letter, then 0–31 more of [a-z0-9_-]. Total 1–32 chars.
const HANDLE_PATTERN = /@([a-z][a-z0-9_-]{0,31})/gi;
const DEFAULT_MAX_LOOKUPS_PER_TURN = 5;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_CACHE_MAX = 256;

type CacheEntry = {
  identity: ImajinIdentity | null;
  expiresAt: number;
};

interface EntityContextOptions {
  maxLookupsPerTurn?: number;
  cacheTtlMs?: number;
  cacheMax?: number;
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}

/**
 * Build the before_prompt_build hook handler.
 */
export function createEntityContextHook(client: ImajinClient, options: EntityContextOptions = {}) {
  const maxLookupsPerTurn = options.maxLookupsPerTurn ?? DEFAULT_MAX_LOOKUPS_PER_TURN;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cacheMax = options.cacheMax ?? DEFAULT_CACHE_MAX;
  const logger = options.logger;
  const cache = new Map<string, CacheEntry>();

  function cacheGet(handle: string): CacheEntry | undefined {
    const entry = cache.get(handle);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      cache.delete(handle);
      return undefined;
    }
    // Refresh LRU order.
    cache.delete(handle);
    cache.set(handle, entry);
    return entry;
  }

  function cacheSet(handle: string, identity: ImajinIdentity | null) {
    if (cache.size >= cacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(handle, { identity, expiresAt: Date.now() + cacheTtlMs });
  }

  return async function entityContextHook(event: {
    prompt: string;
    messages: unknown[];
  }): Promise<{ prependContext: string } | undefined> {
    const text = extractLatestUserText(event.messages) ?? event.prompt;
    if (!text || text.length < 2) return undefined;

    const handles = extractUniqueHandles(text, maxLookupsPerTurn);
    if (handles.length === 0) return undefined;

    const resolved: { handle: string; identity: ImajinIdentity }[] = [];
    await Promise.all(
      handles.map(async (handle) => {
        const cached = cacheGet(handle);
        if (cached) {
          if (cached.identity) resolved.push({ handle, identity: cached.identity });
          return;
        }
        try {
          const identity = await client.lookupIdentity(handle);
          cacheSet(handle, identity);
          if (identity) resolved.push({ handle, identity });
        } catch (err) {
          logger?.warn?.(`imajin entity-context: lookup failed for @${handle}: ${String(err)}`);
        }
      }),
    );

    if (resolved.length === 0) return undefined;

    return {
      prependContext: formatContext(resolved),
    };
  };
}

function extractUniqueHandles(text: string, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(HANDLE_PATTERN)) {
    const h = match[1].toLowerCase();
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

function formatContext(entries: { handle: string; identity: ImajinIdentity }[]): string {
  const lines = ["Identity context (resolved from the Imajin network before this turn):"];
  for (const { handle, identity } of entries) {
    const id = identity as Record<string, unknown>;
    const did = typeof id.did === "string" ? id.did : typeof id.id === "string" ? id.id : "unknown";
    const scope = typeof id.scope === "string" ? id.scope : undefined;
    const subtype = typeof id.subtype === "string" ? id.subtype : undefined;
    const tier = typeof id.tier === "string" ? id.tier : undefined;
    const name = typeof id.name === "string" ? id.name : undefined;
    const parts = [`@${handle}`, `→`, did];
    if (scope || subtype) parts.push(`(${[scope, subtype].filter(Boolean).join("/")})`);
    if (tier) parts.push(`tier=${tier}`);
    if (name) parts.push(`name="${name}"`);
    lines.push(`- ${parts.join(" ")}`);
  }
  lines.push(
    "Use these mappings when the message references these handles. If a handle resolved here is mentioned, prefer this resolved context over guessing.",
  );
  return lines.join("\n");
}

// --- message extraction (mirrors the helper in extensions/memory-lancedb) ---

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function extractUserTextContent(message: unknown): string[] {
  const msgObj = asRecord(message);
  if (!msgObj || msgObj.role !== "user") return [];

  const content = msgObj.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const texts: string[] = [];
  for (const block of content) {
    const blockObj = asRecord(block);
    if (blockObj?.type === "text" && typeof blockObj.text === "string") {
      texts.push(blockObj.text);
    }
  }
  return texts;
}

function extractLatestUserText(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractUserTextContent(messages[i]).join("\n").trim();
    if (text) return text;
  }
  return undefined;
}
