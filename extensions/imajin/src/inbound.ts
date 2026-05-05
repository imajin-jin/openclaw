import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { getImajinRuntime } from "./runtime.js";
import { getImajinChat, getImajinClient } from "./state.js";
import { onMessageReceived, onMessageSent } from "./telemetry.js";
import type { ImajinInboundMessage, ResolvedImajinAccount } from "./types.js";

const CHANNEL_ID = "imajin" as const;

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

  if (text && mediaUrls.length > 0) {
    await chat.sendMessage(params.target, `${text}\n\n${mediaUrls.join("\n")}`);
  } else if (text) {
    await chat.sendMessage(params.target, text);
  } else if (mediaUrls.length > 0) {
    for (const url of mediaUrls) {
      await chat.sendMessage(params.target, url);
    }
  }
}

export async function handleImajinInbound(params: {
  message: ImajinInboundMessage;
  account: ResolvedImajinAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getImajinRuntime();

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

  // Resolve sender identity for display name
  let senderName = message.fromDid.slice(0, 20) + "…";
  try {
    if (client) {
      const identity = await client.lookupIdentity(message.fromDid);
      if (identity) {
        senderName = identity.handle ? `@${identity.handle}` : (identity.displayName ?? senderName);
      }
    }
  } catch {
    // Best-effort identity resolution
  }

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
    GroupSubject: chatType === "group" ? peerId : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.id,
    Timestamp: new Date(message.createdAt).getTime(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: peerId,
    CommandAuthorized: true,
  });

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
