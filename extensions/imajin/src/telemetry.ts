/**
 * Agent telemetry — emit Imajin bus events for inference, messages, and lifecycle.
 *
 * Uses the bracket pattern: correlate message:received → message:sent to
 * estimate inference duration and cost.
 *
 * Fire-and-forget: every emit is async unawaited. Telemetry must NEVER block
 * the message pipeline.
 */

import type { ImajinClient } from "./client.js";
import { getImajinPluginState } from "./state.js";

interface InferenceStart {
  receivedAt: number;
  fromDid: string;
  channel: string;
  sessionKey?: string;
}

// Track in-flight inferences by session key
const inflightInferences = new Map<string, InferenceStart>();

// Local circular buffer for telemetry events (last 100)
const TELEMETRY_BUFFER_SIZE = 100;
const telemetryBuffer: TelemetryEvent[] = [];

// Telemetry event types that will be emitted to Imajin bus
export interface TelemetryEvent {
  type: string;
  timestamp: string;
  agentDid: string;
  payload: Record<string, unknown>;
}

export interface TelemetryEmitter {
  emit(event: TelemetryEvent): void;
}

/**
 * Build the telemetry emitter for the current agent.
 */
function buildEmitter(): TelemetryEmitter {
  const state = getImajinPluginState();
  const agentDid = state.did ?? "unknown";
  const client = state.client;

  return {
    emit(event: TelemetryEvent): void {
      // 1. Buffer locally (circular)
      telemetryBuffer.push(event);
      if (telemetryBuffer.length > TELEMETRY_BUFFER_SIZE) {
        telemetryBuffer.shift();
      }

      // 2. Optionally emit to Imajin bus as an attestation
      //    POST /registry/api/attestations with type agent.telemetry.*
      //    Fire-and-forget — never await, never throw.
      if (client) {
        void emitToBus(client, agentDid, event).catch(() => {
          // Silently drop bus failures. Telemetry is best-effort.
        });
      }
    },
  };
}

/**
 * Fire-and-forget POST to the Imajin attestation endpoint.
 * Maps telemetry events to attestation shape:
 *   { type, issuer, subject, claim }
 */
async function emitToBus(
  client: ImajinClient,
  agentDid: string,
  event: TelemetryEvent,
): Promise<void> {
  try {
    await client.postRaw("/registry/api/attestations", {
      type: `agent.telemetry.${event.type}`,
      issuer: agentDid,
      subject: agentDid,
      claim: {
        ...event.payload,
        _telemetryType: event.type,
        _telemetryTimestamp: event.timestamp,
      },
    });
  } catch {
    // Best-effort: if the bus is down or auth fails, we still have the
    // local buffer. No retry, no blocking.
  }
}

/** Get a snapshot of the local telemetry buffer (newest last). */
export function getTelemetryBuffer(): readonly TelemetryEvent[] {
  return telemetryBuffer.slice();
}

/** Clear the telemetry buffer (useful for testing). */
export function clearTelemetryBuffer(): void {
  telemetryBuffer.length = 0;
}

// ---------------------------------------------------------------------------
// Bracket-pattern handlers
// ---------------------------------------------------------------------------

/**
 * Call when an inbound message is received (start of inference bracket).
 */
export function onMessageReceived(
  sessionKey: string | undefined,
  fromDid: string,
  channel: string,
): void {
  const key = sessionKey ?? `${fromDid}::${channel}::${Date.now()}`;
  inflightInferences.set(key, {
    receivedAt: Date.now(),
    fromDid,
    channel,
    sessionKey,
  });

  const state = getImajinPluginState();
  const agentDid = state.did ?? "unknown";
  const emitter = buildEmitter();

  emitter.emit({
    type: "agent.message.received",
    timestamp: new Date().toISOString(),
    agentDid,
    payload: {
      fromDid,
      channel,
      sessionKey: sessionKey ?? null,
      timestamp: Date.now(),
    },
  });
}

/**
 * Call when an outbound message is sent (end of inference bracket).
 * Calculates duration and emits agent.inference.completed.
 */
export function onMessageSent(
  sessionKey: string | undefined,
  toDid: string,
  channel: string,
  success: boolean,
): void {
  const key = sessionKey ?? `${toDid}::${channel}::${Date.now()}`;
  const start = inflightInferences.get(key);
  const durationMs = start ? Date.now() - start.receivedAt : undefined;

  // Remove from in-flight map (bracket is closed)
  inflightInferences.delete(key);

  const state = getImajinPluginState();
  const agentDid = state.did ?? "unknown";
  const emitter = buildEmitter();

  // Emit message.sent
  emitter.emit({
    type: "agent.message.sent",
    timestamp: new Date().toISOString(),
    agentDid,
    payload: {
      toDid,
      channel,
      success,
      sessionKey: sessionKey ?? null,
      timestamp: Date.now(),
    },
  });

  // Emit inference.completed (only if we had a matching start)
  if (durationMs !== undefined) {
    emitter.emit({
      type: "agent.inference.completed",
      timestamp: new Date().toISOString(),
      agentDid,
      payload: {
        durationMs,
        channel,
        sessionKey: sessionKey ?? null,
        timestamp: Date.now(),
        // TODO(#853): add model, tokens, cost estimate when available
        model: null,
        inputTokens: null,
        outputTokens: null,
        estimatedCost: null,
      },
    });
  }
}

/**
 * Call when the agent / gateway lifecycle starts.
 */
export function onLifecycleStart(agentDid: string, nodeUrl: string): void {
  const emitter = buildEmitter();
  emitter.emit({
    type: "agent.lifecycle.started",
    timestamp: new Date().toISOString(),
    agentDid,
    payload: {
      nodeUrl,
      timestamp: Date.now(),
    },
  });
}
