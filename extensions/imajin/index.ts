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
import { setImajinPluginState } from "./src/state.js";
import { setImajinRuntime } from "./src/runtime.js";

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

    // Chat tool — requires keypair for auth
    if (chat) {
      api.registerTool(createChatTool(chat));
    }
  },
});
