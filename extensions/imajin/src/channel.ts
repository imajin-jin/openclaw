import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { startImajinGatewayAccount } from "./gateway.js";
import { getImajinPluginState } from "./state.js";
import type { ResolvedImajinAccount } from "./types.js";

const CHANNEL_ID = "imajin" as const;

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 4000, 8000]; // exponential backoff

async function sendWithRetry(fn: () => Promise<void>, label: string): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      const isLastAttempt = attempt === MAX_RETRIES;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isLastAttempt) {
        console.error(`[imajin] ${label} failed after ${MAX_RETRIES + 1} attempts: ${errMsg}`);
        throw err;
      }
      const delay = RETRY_DELAYS[attempt] ?? 8000;
      console.warn(
        `[imajin] ${label} attempt ${attempt + 1} failed (${errMsg}), retrying in ${delay}ms...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

const meta = {
  id: CHANNEL_ID,
  label: "Imajin",
  selectionLabel: "Imajin (DID + Node URL)",
  docsPath: "/channels/imajin",
  docsLabel: "imajin",
  blurb: "Imajin sovereign identity and settlement network.",
  order: 75,
  detailLabel: "Imajin",
  markdownCapable: true,
};

function resolveImajinAccount(accountId?: string | null): ResolvedImajinAccount {
  const state = getImajinPluginState();
  return {
    accountId: accountId || "default",
    enabled: true,
    configured: Boolean(state.nodeUrl),
    nodeUrl: state.nodeUrl,
    did: state.did,
    keypairPath: state.keypairPath,
  };
}

export const imajinPlugin: ChannelPlugin<ResolvedImajinAccount> = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta,
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      blockStreaming: true,
    },
    reload: { configPrefixes: ["plugins.entries.imajin"] },
    setup: {
      applyAccountConfig: ({ cfg }) => cfg,
    },
    config: {
      listAccountIds: () => {
        const state = getImajinPluginState();
        return state.nodeUrl ? ["default"] : [];
      },
      resolveAccount: (_cfg, accountId) => resolveImajinAccount(accountId),
      defaultAccountId: () => "default",
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            nodeUrl: account.nodeUrl,
            did: account.did,
          },
        }),
    },
    messaging: {
      normalizeTarget: (target: string) => target.trim(),
      targetResolver: {
        looksLikeId: (id: string) => {
          const trimmed = id?.trim();
          if (!trimmed) return false;
          return trimmed.startsWith("did:imajin:");
        },
        hint: "<did:imajin:...>",
      },
    },
    gateway: {
      startAccount: async (ctx) =>
        await startImajinGatewayAccount({
          cfg: ctx.cfg as OpenClawConfig,
          accountId: ctx.accountId,
          account: ctx.account as ResolvedImajinAccount,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          setStatus: ctx.setStatus,
          log: ctx.log,
        }),
    },
  },
  outbound: {
    deliveryMode: "gateway",
    sendText: async ({ to, text }) => {
      const chat = getImajinPluginState().chat;
      if (!chat) {
        throw new Error("Imajin chat not initialized");
      }
      await sendWithRetry(
        () => chat.sendMessage(to, text).then(() => {}),
        `sendText to ${to.slice(0, 30)}`,
      );
      return attachChannelToResult(CHANNEL_ID, {
        messageId: `imajin-${Date.now()}`,
        chatId: to,
      });
    },
    sendMedia: async ({ to, mediaUrl }) => {
      const chat = getImajinPluginState().chat;
      if (!chat) {
        throw new Error("Imajin chat not initialized");
      }
      await sendWithRetry(
        () => chat.sendMessage(to, mediaUrl ?? "").then(() => {}),
        `sendMedia to ${to.slice(0, 30)}`,
      );
      return attachChannelToResult(CHANNEL_ID, {
        messageId: `imajin-${Date.now()}`,
        chatId: to,
      });
    },
  },
});
