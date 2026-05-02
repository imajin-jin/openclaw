/**
 * OpenClaw Imajin Plugin
 *
 * Connects an OpenClaw agent to the Imajin network.
 * Registers tools for the five primitives: identity, attestation,
 * attribution (.fair), settlement, and discovery.
 *
 * Config (openclaw.json):
 *   "imajin": {
 *     "enabled": true,
 *     "config": {
 *       "nodeUrl": "https://jin.imajin.ai",
 *       "did": "did:imajin:...",
 *       "keypairPath": "/path/to/.jin-identity.json"
 *     }
 *   }
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ImajinClient } from "./src/client.js";
import {
  createIdentityTool,
  createAttestTool,
  createTransactTool,
  createFairTool,
  createDiscoverTool,
  createMediaTool,
  createChatTool,
} from "./src/tools.js";
import { ImajinChat } from "./src/chat.js";
import { ImajinService } from "./src/service.js";

export default definePluginEntry({
  id: "imajin",
  name: "Imajin Network",
  description:
    "Connect to the Imajin sovereign identity and settlement network. " +
    "Provides tools for identity lookup, attestations, .fair attribution, " +
    "MJNx/MJN settlement, and network discovery.",

  register(api) {
    const config = (api.pluginConfig ?? {}) as {
      nodeUrl?: string;
      did?: string;
      keypairPath?: string;
    };

    if (!config?.nodeUrl) {
      api.logger.warn(
        "Imajin plugin: no nodeUrl configured. Set plugins.entries.imajin.config.nodeUrl in openclaw.json",
      );
      return;
    }

    const client = new ImajinClient({
      nodeUrl: config.nodeUrl,
      did: config.did,
      keypairPath: config.keypairPath,
    });

    // Register the five primitive tools + media + chat
    api.registerTool(createIdentityTool(client));
    api.registerTool(createAttestTool(client));
    api.registerTool(createTransactTool(client));
    api.registerTool(createFairTool(client));
    api.registerTool(createDiscoverTool(client));
    api.registerTool(createMediaTool(client));

    // Chat — requires keypair for auth
    if (config.keypairPath) {
      const agentDid = config.did || "";
      const chat = new ImajinChat(client, agentDid);
      api.registerTool(createChatTool(chat));

      // Background WebSocket service — receive inbound messages (#848)
      const service = new ImajinService({
        client,
        chat,
        config: {
          nodeUrl: config.nodeUrl,
          agentDid,
        },
        logger: {
          info: (msg) => api.logger.info(msg),
          warn: (msg) => api.logger.warn(msg),
          error: (msg) => api.logger.error(msg),
          debug: (msg) => api.logger.debug?.(msg),
        },
        injector: {
          enqueue: async (params) => {
            const result = await api.enqueueNextTurnInjection({
              sessionKey: params.sessionKey,
              text: params.text,
              idempotencyKey: params.idempotencyKey,
              placement: "append_context",
              ttlMs: 300_000, // 5 minute TTL
            });
            return { enqueued: result.enqueued };
          },
        },
      });

      api.registerService({
        id: "imajin-ws",
        start: async () => {
          await service.start();
        },
        stop: async () => {
          await service.stop();
        },
      });
    }

    // TODO: registerMemoryCorpusSupplement — agent's chain as searchable memory
    // TODO: registerHook("before_tool_call") — entity context decorator
    // TODO: registerChannel — Imajin chat as a full messaging channel (#849)
    // TODO: registerHttpRoute — webhook receiver for Imajin events
  },
});
