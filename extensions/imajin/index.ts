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
} from "./src/tools.js";

export default definePluginEntry({
  id: "imajin",
  name: "Imajin Network",
  description:
    "Connect to the Imajin sovereign identity and settlement network. " +
    "Provides tools for identity lookup, attestations, .fair attribution, " +
    "MJNx/MJN settlement, and network discovery.",

  register(api) {
    const config = api.getConfig() as {
      nodeUrl?: string;
      did?: string;
      keypairPath?: string;
    };

    if (!config?.nodeUrl) {
      api.log?.warn?.(
        "Imajin plugin: no nodeUrl configured. Set plugins.entries.imajin.config.nodeUrl in openclaw.json",
      );
      return;
    }

    const client = new ImajinClient({
      nodeUrl: config.nodeUrl,
      did: config.did,
      keypairPath: config.keypairPath,
    });

    // Register the five primitive tools
    api.registerTool(createIdentityTool(client));
    api.registerTool(createAttestTool(client));
    api.registerTool(createTransactTool(client));
    api.registerTool(createFairTool(client));
    api.registerTool(createDiscoverTool(client));

    // TODO: registerMemoryCorpusSupplement — agent's chain as searchable memory
    // TODO: registerHook("before_tool_call") — entity context decorator
    // TODO: registerService — background node connection + auth refresh
    // TODO: registerHttpRoute — webhook receiver for Imajin events
  },
});
