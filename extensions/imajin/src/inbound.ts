import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { ImajinIdentity } from "./client.js";
import { getImajinRuntime } from "./runtime.js";
import { getImajinChat, getImajinClient } from "./state.js";
import { onMessageReceived, onMessageSent } from "./telemetry.js";
import type { ImajinInboundMessage, ResolvedImajinAccount } from "./types.js";

const CHANNEL_ID = "imajin" as const;

/**
 * Buffer outbound messages per conversation to avoid spamming multiple
 * messages when the LLM does multi-step reasoning with intermediate outputs.
 * Collects all deliver() calls within a flush window, then sends as one message.
 */
const outboundBuffers = new Map<
  string,
  { parts: string[]; timer: ReturnType<typeof setTimeout> | null }
>();
const FLUSH_DELAY_MS = 1500; // wait 1.5s after last deliver() before sending

const identityCache = new Map<string, { identity: ImajinIdentity | null; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedIdentity(did: string): ImajinIdentity | null | undefined {
  const entry = identityCache.get(did);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    identityCache.delete(did);
    return undefined;
  }
  return entry.identity;
}

function setCachedIdentity(did: string, identity: ImajinIdentity | null): void {
  identityCache.set(did, { identity, expiresAt: Date.now() + CACHE_TTL });
}

function flushBuffer(target: string): void {
  const buf = outboundBuffers.get(target);
  if (!buf || buf.parts.length === 0) {
    outboundBuffers.delete(target);
    return;
  }

  const combined = buf.parts.join("\n\n").trim();
  outboundBuffers.delete(target);

  if (!combined) return;

  const chat = getImajinChat();
  if (!chat) return;

  chat.sendMessage(target, combined).catch((err) => {
    // Best-effort — log but don't throw
    console.error(`[imajin] Failed to send buffered message to ${target.slice(0, 30)}: ${err}`);
  });
}

async function deliverImajinReply(params: {
  payload: OutboundReplyPayload;
  target: string;
  accountId: string;
}): Promise<void> {
  const chat = getImajinChat();
  if (!chat) {
    throw new Error("Imajin chat not initialized");
  }

  const text = params.payload.text?.trim() ?? "";
  const mediaUrls =
    params.payload.mediaUrls ?? (params.payload.mediaUrl ? [params.payload.mediaUrl] : []);

  // Combine text and media URLs into a single part
  let part = "";
  if (text && mediaUrls.length > 0) {
    part = `${text}\n\n${mediaUrls.join("\n")}`;
  } else if (text) {
    part = text;
  } else if (mediaUrls.length > 0) {
    part = mediaUrls.join("\n");
  }

  if (!part) return;

  // Buffer the part and reset the flush timer
  let buf = outboundBuffers.get(params.target);
  if (!buf) {
    buf = { parts: [], timer: null };
    outboundBuffers.set(params.target, buf);
  }
  buf.parts.push(part);

  // Reset flush timer — waits for more parts before sending
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flushBuffer(params.target), FLUSH_DELAY_MS);
}

export async function handleImajinInbound(params: {
  message: ImajinInboundMessage;
  account: ResolvedImajinAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  runtime.log?.(`imajin: handleImajinInbound called for ${message.id} from ${message.fromDid}`);
  let core;
  try {
    core = getImajinRuntime();
  } catch (err) {
    runtime.error?.(
      `imajin: getImajinRuntime failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  runtime.log?.(`imajin: runtime resolved, processing message`);

  // Extract text content
  const rawBody =
    typeof message.content === "string" ? message.content : (message.content?.text ?? "");

  if (!rawBody.trim()) {
    return;
  }

  // Telemetry: start inference bracket
  onMessageReceived(undefined, message.fromDid, CHANNEL_ID);

  statusSink?.({ lastInboundAt: Date.now() });

  const client = getImajinClient();

  // Resolve sender identity for display name and label (with cache)
  let resolvedIdentity: ImajinIdentity | null = null;
  const cached = getCachedIdentity(message.fromDid);
  if (cached !== undefined) {
    resolvedIdentity = cached;
  } else {
    try {
      if (client) {
        resolvedIdentity = await client.lookupIdentity(message.fromDid);
        setCachedIdentity(message.fromDid, resolvedIdentity);
      }
    } catch {
      setCachedIdentity(message.fromDid, null);
    }
  }

  const senderHandle = resolvedIdentity?.handle ?? undefined;
  const senderName = senderHandle
    ? `@${senderHandle}`
    : (resolvedIdentity?.name ??
      resolvedIdentity?.displayName ??
      message.fromDid.slice(0, 20) + "…");
  const senderLabel = `${senderName} (${message.fromDid})`;

  // Determine chat type from conversation DID
  const isDm = message.conversationDid.includes(":dm:");
  const chatType = isDm ? "direct" : "group";
  const peerId = message.conversationDid;

  // Resolve agent route
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: chatType,
      id: peerId,
    },
  });

  // Build session store path
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });

  // Build inbound context payload
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: message.fromDid,
    To: peerId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: peerId,
    SenderName: senderName,
    SenderId: message.fromDid,
    SenderScope: resolvedIdentity?.scope,
    SenderSubtype: resolvedIdentity?.subtype,
    SenderTier: resolvedIdentity?.tier,
    SenderHandle: senderHandle,
    SenderDisplayName: resolvedIdentity?.displayName ?? resolvedIdentity?.name,
    GroupSubject: chatType === "group" ? peerId : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.id,
    Timestamp: new Date(message.createdAt).getTime(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: peerId,
    CommandAuthorized: true,
  });

  runtime.log?.(`imajin: dispatching to session ${route.sessionKey}`);

  // Dispatch via OpenClaw
  await dispatchInboundReplyWithBase({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    route,
    storePath,
    ctxPayload,
    core,
    deliver: async (payload) => {
      try {
        await deliverImajinReply({
          payload,
          target: peerId,
          accountId: account.accountId,
        });
        // Telemetry: end inference bracket (success)
        onMessageSent(undefined, peerId, CHANNEL_ID, true);
      } catch (err) {
        // Telemetry: end inference bracket (failure)
        onMessageSent(undefined, peerId, CHANNEL_ID, false);
        throw err;
      }
      statusSink?.({ lastOutboundAt: Date.now() });
    },
    onRecordError: (err) => {
      runtime.error?.(`imajin: failed updating session meta: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      runtime.error?.(`imajin ${info.kind} reply failed: ${String(err)}`);
    },
  });
}
