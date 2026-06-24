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
import { ImajinChat } from "./src/chat.js";
import { ImajinClient } from "./src/client.js";
import { createEntityContextHook } from "./src/entity-context.js";
import {
  createIdentityTool,
  createAttestTool,
  createTransactTool,
  createFairTool,
  createDiscoverTool,
  createMediaTool,
  createChatTool,
} from "./src/tools.js";

export default definePluginEntry({
  id: "imajin",
  name: "Imajin Network",
  description:
    "Connect to the Imajin sovereign identity and settlement network. " +
    "Provides tools for identity lookup, attestations, .fair attribution, " +
    "MJNx/MJN settlement, and network discovery.",

  register(api) {
    // pluginConfig is the per-entry config block from openclaw.json
    // (plugins.entries.imajin.config). The old code called api.getConfig()
    // which is not on the plugin SDK surface — the whole plugin failed to
    // register with TypeError before this fix.
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
    }

    // Entity context decorator (#846 item 3): before each turn, scan the
    // latest user message for @handles and resolve them via the Imajin
    // identity graph. Resolved entries are prepended to the prompt so the
    // model has DID/scope/subtype/tier before it answers.
    api.on("before_prompt_build", createEntityContextHook(client, { logger: api.logger }));

    // TODO (#846 item 4): registerMemoryCorpusSupplement — agent's chain
    // (attestations + transactions + connections) as a queryable corpus
    // surfaced through memory_search.
  },
});
