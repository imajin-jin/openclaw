/**
 * Runtime barrel for the bundled Imajin extension.
 * Keep this thin so bootstrap/discovery paths stay lightweight.
 */

export type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
export type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
export {
  createChatChannelPlugin,
  defineChannelPluginEntry,
} from "openclaw/plugin-sdk/channel-core";
export { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
export { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
export {
  deliverFormattedTextWithAttachments,
  resolveOutboundMediaUrls,
} from "openclaw/plugin-sdk/reply-payload";
export {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
export { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
export { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
export { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
export { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
export { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
