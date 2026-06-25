/**
 * OpenClaw Imajin Channel Plugin
 *
 * Connects an OpenClaw agent to the Imajin network as a full messaging channel.
 * Inbound messages via WebSocket create OpenClaw sessions; replies route back
 * through Imajin chat.
 *
 * Also registers tools for the five primitives: identity, attestation,
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

import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { ImajinChat } from "./src/chat.js";
import { ImajinClient } from "./src/client.js";
import { setImajinRuntime } from "./src/runtime.js";
import { setImajinPluginState } from "./src/state.js";
import { onLifecycleStart } from "./src/telemetry.js";
import {
  createIdentityTool,
  createAttestTool,
  createTransactTool,
  createFairTool,
  createDiscoverTool,
  createMediaTool,
  createConnectionsTool,
  createChatTool,
} from "./src/tools.js";

export default defineBundledChannelEntry({
  id: "imajin",
  name: "Imajin",
  description:
    "Imajin sovereign identity and settlement network. " +
    "Provides messaging, identity lookup, attestations, .fair attribution, " +
    "MJNx/MJN settlement, and network discovery.",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "imajinPlugin",
  },
  runtime: {
    specifier: "./src/runtime.js",
    exportName: "setImajinRuntime",
  },
  registerFull(api) {
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

    // Store state for the channel plugin to access
    const agentDid = config.did || "";
    const chat = config.keypairPath ? new ImajinChat(client, agentDid) : null;
    setImajinPluginState({
      nodeUrl: config.nodeUrl,
      did: config.did,
      keypairPath: config.keypairPath,
      client,
      chat,
    });

    // Register the five primitive tools + media
    api.registerTool(createIdentityTool(client));
    api.registerTool(createAttestTool(client));
    api.registerTool(createTransactTool(client));
    api.registerTool(createFairTool(client));
    api.registerTool(createDiscoverTool(client));
    api.registerTool(createMediaTool(client));
    api.registerTool(createConnectionsTool(client));

    // Chat tool — requires keypair for auth
    if (chat) {
      api.registerTool(createChatTool(chat));
    }

    // -----------------------------------------------------------------------
    // Telemetry — bracket pattern in inbound.ts correlates received → sent
    // to estimate inference duration. Lifecycle event emitted here on init.
    // Foundation for agent pricing (#853).
    //
    // TODO: When OpenClaw adds message:preprocessed and session:patch hooks,
    // register them here via api.registerHook() for enrichment + config tracking.
    // -----------------------------------------------------------------------
    onLifecycleStart(config.did || "", config.nodeUrl);
  },
});
