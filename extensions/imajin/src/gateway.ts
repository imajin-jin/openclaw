import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { ResolvedImajinAccount } from "./types.js";
import { getImajinPluginState } from "./state.js";
import { ImajinService } from "./service.js";
import { handleImajinInbound } from "./inbound.js";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";

export async function startImajinGatewayAccount(ctx: {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedImajinAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  setStatus: (next: ChannelAccountSnapshot) => void;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<void> {
  const account = ctx.account;
  const statusSink = createAccountStatusSink({
    accountId: ctx.accountId,
    setStatus: ctx.setStatus,
  });

  if (!account.configured) {
    throw new Error(
      `Imajin is not configured for account "${account.accountId}" (need nodeUrl in pluginConfig).`,
    );
  }

  ctx.log?.info?.(
    `[${account.accountId}] starting Imajin provider (${account.nodeUrl})`,
  );

  const state = getImajinPluginState();
  if (!state.client || !state.chat) {
    throw new Error("Imajin client/chat not initialized — registerFull may not have run.");
  }

  await runStoppablePassiveMonitor({
    abortSignal: ctx.abortSignal,
    start: async () => {
      const service = new ImajinService({
        client: state.client!,
        chat: state.chat!,
        config: {
          nodeUrl: account.nodeUrl || "",
          agentDid: account.did || "",
        },
        logger: {
          info: (msg) => ctx.log?.info?.(`[imajin-ws] ${msg}`),
          warn: (msg) => ctx.log?.warn?.(`[imajin-ws] ${msg}`),
          error: (msg) => ctx.log?.error?.(`[imajin-ws] ${msg}`),
          debug: (msg) => ctx.log?.info?.(`[imajin-ws] ${msg}`),
        },
      });

      service.onMessage = async (message) => {
        await handleImajinInbound({
          message,
          account,
          config: ctx.cfg,
          runtime: ctx.runtime,
          statusSink,
        });
      };

      await service.start();

      return {
        stop: () => {
          void service.stop();
        },
      };
    },
  });
}
