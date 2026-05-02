import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getImajinPluginState } from "./state.js";
import { startImajinGatewayAccount } from "./gateway.js";
import type { ResolvedImajinAccount } from "./types.js";

const CHANNEL_ID = "imajin" as const;

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
      await chat.sendMessage(to, text);
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
      await chat.sendMessage(to, mediaUrl ?? "");
      return attachChannelToResult(CHANNEL_ID, {
        messageId: `imajin-${Date.now()}`,
        chatId: to,
      });
    },
  },
});
