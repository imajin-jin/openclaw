/**
 * Module-level state bridge for Imajin plugin.
 *
 * registerFull populates this from api.pluginConfig.
 * The channel plugin reads from it during gateway start and outbound sends.
 */

import type { ImajinClient } from "./client.js";
import type { ImajinChat } from "./chat.js";

type ImajinPluginState = {
  nodeUrl?: string;
  did?: string;
  keypairPath?: string;
  client: ImajinClient | null;
  chat: ImajinChat | null;
};

let state: ImajinPluginState = {
  client: null,
  chat: null,
};

export function setImajinPluginState(next: Partial<ImajinPluginState>): void {
  state = { ...state, ...next };
}

export function getImajinPluginState(): Readonly<ImajinPluginState> {
  return state;
}

export function getImajinClient(): ImajinClient | null {
  return state.client;
}

export function getImajinChat(): ImajinChat | null {
  return state.chat;
}
