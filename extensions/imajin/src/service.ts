/**
 * Imajin Background WebSocket Service
 *
 * Maintains a persistent WebSocket connection to the Imajin node.
 * Emits inbound messages via the `onMessage` callback for the channel
 * plugin's inbound handler to dispatch.
 *
 * Auth flow:
 * 1. Authenticate via Ed25519 challenge-response → session cookie
 * 2. GET /chat/api/ws-token with session cookie → short-lived WS token
 * 3. Connect to wss://node/chat/ws
 * 4. Send { type: "auth", token } → receive { type: "connected" }
 * 5. Subscribe to conversation DIDs
 *
 * Reconnects with exponential backoff on disconnect.
 */

import type { ImajinClient } from "./client.js";
import type { ImajinChat } from "./chat.js";
import type { ImajinInboundMessage } from "./types.js";

export interface ImajinServiceConfig {
  nodeUrl: string;
  agentDid: string;
}

export interface ImajinServiceLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

/**
 * Inbound message from WebSocket.
 */
interface WsNewMessage {
  type: "new_message";
  message: {
    id: string;
    conversationDid: string;
    fromDid: string;
    content: { type: string; text: string } | string;
    contentType: string;
    replyToMessageId?: string | null;
    replyToDid?: string | null;
    createdAt: string;
    signature?: string | null;
  };
}

interface WsEvent {
  type: string;
  [key: string]: unknown;
}

const MIN_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60000;
const SUBSCRIPTION_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
const PING_INTERVAL = 30000;

export class ImajinService {
  private ws: WebSocket | null = null;
  private client: ImajinClient;
  private chat: ImajinChat;
  private config: ImajinServiceConfig;
  private logger: ImajinServiceLogger;

  private reconnectDelay = MIN_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptionTimer: ReturnType<typeof setInterval> | null = null;
  private subscribedConversations = new Set<string>();
  private stopped = false;

  // Track messages we sent so we can skip the echo
  private sentMessageIds = new Set<string>();
  private sentMessageCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Called for each inbound message (after self-echo filtering). */
  onMessage?: (message: ImajinInboundMessage) => void | Promise<void>;

  constructor(params: {
    client: ImajinClient;
    chat: ImajinChat;
    config: ImajinServiceConfig;
    logger: ImajinServiceLogger;
  }) {
    this.client = params.client;
    this.chat = params.chat;
    this.config = params.config;
    this.logger = params.logger;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.logger.info("[imajin-ws] Starting WebSocket service");
    await this.connect();

    // Periodically clean old sent message IDs (keep for 2 minutes)
    this.sentMessageCleanupTimer = setInterval(() => {
      if (this.sentMessageIds.size > 100) {
        this.sentMessageIds.clear();
      }
    }, 120_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.logger.info("[imajin-ws] Stopping WebSocket service");
    this.cleanup();
  }

  /**
   * Record a message ID we sent so we can skip the WS echo.
   */
  trackSentMessage(messageId: string): void {
    this.sentMessageIds.add(messageId);
    setTimeout(() => this.sentMessageIds.delete(messageId), 60_000);
  }

  // --- Connection lifecycle ---

  private async connect(): Promise<void> {
    if (this.stopped) return;

    try {
      await this.client.authenticate();

      const wsToken = await this.getWsToken();
      if (!wsToken) {
        this.logger.error("[imajin-ws] Failed to get WS token");
        this.scheduleReconnect();
        return;
      }

      const wsUrl = this.buildWsUrl();
      this.logger.info(`[imajin-ws] Connecting to ${wsUrl}`);

      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.logger.info("[imajin-ws] WebSocket connected, sending auth");
        ws.send(JSON.stringify({ type: "auth", token: wsToken }));
      });

      ws.addEventListener("message", (event) => {
        this.handleMessage(event.data as string);
      });

      ws.addEventListener("close", (event) => {
        this.logger.warn(
          `[imajin-ws] WebSocket closed: code=${event.code} reason=${event.reason}`,
        );
        this.onDisconnect();
      });

      ws.addEventListener("error", (event) => {
        this.logger.error(`[imajin-ws] WebSocket error: ${String(event)}`);
      });
    } catch (err) {
      this.logger.error(
        `[imajin-ws] Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect();
    }
  }

  private onDisconnect(): void {
    this.clearTimers();
    this.ws = null;
    this.subscribedConversations.clear();

    if (!this.stopped) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    this.logger.info(`[imajin-ws] Reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  private resetReconnectDelay(): void {
    this.reconnectDelay = MIN_RECONNECT_DELAY;
  }

  // --- Message handling ---

  private handleMessage(raw: string): void {
    let event: WsEvent;
    try {
      event = JSON.parse(raw) as WsEvent;
    } catch {
      this.logger.warn(`[imajin-ws] Invalid JSON: ${raw.slice(0, 100)}`);
      return;
    }

    switch (event.type) {
      case "connected":
        this.logger.info("[imajin-ws] Authenticated successfully");
        this.resetReconnectDelay();
        this.startPing();
        this.subscribeToConversations();
        break;

      case "auth_required":
        this.logger.warn("[imajin-ws] Auth required — token may have expired");
        break;

      case "error":
        this.logger.error(
          `[imajin-ws] Server error: ${(event as { message?: string }).message}`,
        );
        break;

      case "pong":
        break;

      case "new_message":
        void this.handleNewMessage(event as unknown as WsNewMessage);
        break;

      case "message_updated":
        break;

      case "user_typing":
      case "user_stop_typing":
      case "user_presence":
        break;

      default:
        this.logger.debug?.(`[imajin-ws] Unhandled event type: ${event.type}`);
    }
  }

  private async handleNewMessage(event: WsNewMessage): Promise<void> {
    const { message } = event;

    // Skip our own messages (echo prevention)
    if (message.fromDid === this.config.agentDid) {
      return;
    }
    if (this.sentMessageIds.has(message.id)) {
      this.sentMessageIds.delete(message.id);
      return;
    }

    const text =
      typeof message.content === "string"
        ? message.content
        : message.content?.text ?? "";

    if (!text.trim()) return;

    this.logger.info(
      `[imajin-ws] Inbound message from ${message.fromDid} in ${message.conversationDid}`,
    );

    if (this.onMessage) {
      try {
        await this.onMessage({
          id: message.id,
          conversationDid: message.conversationDid,
          fromDid: message.fromDid,
          content: message.content,
          contentType: message.contentType,
          replyToMessageId: message.replyToMessageId,
          replyToDid: message.replyToDid,
          createdAt: message.createdAt,
          signature: message.signature,
        });
      } catch (err) {
        this.logger.error(
          `[imajin-ws] onMessage handler failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // --- Subscriptions ---

  private async subscribeToConversations(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      const conversations = await this.chat.listConversations();
      for (const conv of conversations) {
        if (!this.subscribedConversations.has(conv.did)) {
          this.ws.send(
            JSON.stringify({ type: "subscribe", conversationId: conv.did }),
          );
          this.subscribedConversations.add(conv.did);
        }
      }
      this.logger.info(
        `[imajin-ws] Subscribed to ${this.subscribedConversations.size} conversations`,
      );
    } catch (err) {
      this.logger.error(
        `[imajin-ws] Failed to list conversations: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!this.subscriptionTimer) {
      this.subscriptionTimer = setInterval(() => {
        this.subscribeToConversations();
      }, SUBSCRIPTION_REFRESH_INTERVAL);
    }
  }

  // --- WS Token ---

  private async getWsToken(): Promise<string | null> {
    try {
      const res = await this.client.getRaw("/chat/api/ws-token");
      return (res as { token?: string }).token ?? null;
    } catch (err) {
      this.logger.error(
        `[imajin-ws] WS token request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // --- Ping/keepalive ---

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL);
  }

  // --- URL helpers ---

  private buildWsUrl(): string {
    const url = new URL(this.config.nodeUrl);
    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${url.host}/chat/ws`;
  }

  // --- Cleanup ---

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.subscriptionTimer) {
      clearInterval(this.subscriptionTimer);
      this.subscriptionTimer = null;
    }
  }

  private cleanup(): void {
    this.clearTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sentMessageCleanupTimer) {
      clearInterval(this.sentMessageCleanupTimer);
      this.sentMessageCleanupTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedConversations.clear();
  }
}
