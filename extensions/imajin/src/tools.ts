/**
 * Imajin tools for OpenClaw agents.
 *
 * Five tools mapping to Imajin's five primitives:
 * 1. imajin_identity  — look up DIDs, check trust graph, resolve handles
 * 2. imajin_attest    — create and verify attestations
 * 3. imajin_transact  — check balances, view transactions, initiate payments
 * 4. imajin_fair      — inspect .fair attribution manifests
 * 5. imajin_discover  — search the network (people, events, market, stubs)
 */

import { readFile } from "node:fs/promises";
import type { ImajinChat } from "./chat.js";
import type { ImajinClient } from "./client.js";

type ToolContent = { type: "text"; text: string };
type ToolResult = {
  content: ToolContent[];
  details?: Record<string, unknown>;
};

function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(msg: string): ToolResult {
  return textResult(`Error: ${msg}`, { error: true });
}

function jsonResult(data: unknown): ToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

function truncateResults(data: unknown[], max = 20): unknown[] {
  if (data.length <= max) return data;
  return [...data.slice(0, max), { _truncated: true, total: data.length, showing: max }];
}

// --- Tool definitions ---

export function createIdentityTool(client: ImajinClient) {
  return {
    name: "imajin_identity",
    label: "Imajin Identity",
    description:
      "Look up identities on the Imajin network. Actions: lookup (by handle/name/DID), " +
      "connections (get trust graph connections for a DID).",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["lookup", "connections"],
          description: "Action to perform",
        },
        query: {
          type: "string" as const,
          description: "Handle, name, or DID to look up",
        },
      },
      required: ["action", "query"],
    },
    async execute(_id: string, params: { action: string; query: string }): Promise<ToolResult> {
      try {
        switch (params.action) {
          case "lookup": {
            const identity = await client.lookupIdentity(params.query);
            if (!identity) return textResult(`No identity found for: ${params.query}`);
            return jsonResult(identity);
          }
          case "connections": {
            const connections = await client.getConnections();
            if (!connections.length) return textResult("No connections yet.");
            return jsonResult(connections);
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createAttestTool(client: ImajinClient) {
  return {
    name: "imajin_attest",
    label: "Imajin Attestation",
    description:
      "Create or verify attestations on the Imajin network. Actions: list (get attestations for a DID), " +
      "create (create a new attestation — requires agent keypair).",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["list", "create"],
          description: "Action to perform",
        },
        did: {
          type: "string" as const,
          description: "DID to list attestations for, or subject DID for creation",
        },
        type: {
          type: "string" as const,
          description: "Attestation type (for create)",
        },
        claim: {
          type: "object" as const,
          description: "Claim data (for create)",
        },
      },
      required: ["action", "did"],
    },
    async execute(
      _id: string,
      params: { action: string; did: string; type?: string; claim?: Record<string, unknown> },
    ): Promise<ToolResult> {
      try {
        switch (params.action) {
          case "list": {
            const attestations = await client.getAttestations(params.did);
            if (!attestations.length) return textResult(`No attestations found for: ${params.did}`);
            return jsonResult(attestations);
          }
          case "create": {
            if (!params.type || !params.claim) {
              return errorResult("create requires 'type' and 'claim' parameters");
            }
            const attestation = await client.createAttestation({
              type: params.type,
              issuer: "", // will be set by the node from agent DID
              subject: params.did,
              claim: params.claim,
            });
            return jsonResult(attestation);
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createTransactTool(client: ImajinClient) {
  return {
    name: "imajin_transact",
    label: "Imajin Settlement",
    description:
      "Check MJNx/MJN balances and view transaction history on the Imajin network. " +
      "Actions: balance (check balance for a DID), transactions (list recent transactions).",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["balance", "transactions"],
          description: "Action to perform",
        },
        did: {
          type: "string" as const,
          description: "DID to check (defaults to agent's own DID if omitted)",
        },
        limit: {
          type: "number" as const,
          description: "Number of transactions to return (default 20)",
        },
      },
      required: ["action"],
    },
    async execute(
      _id: string,
      params: { action: string; did?: string; limit?: number },
    ): Promise<ToolResult> {
      try {
        switch (params.action) {
          case "balance": {
            const balance = await client.getBalance(params.did);
            return jsonResult(balance);
          }
          case "transactions": {
            const txns = await client.getTransactions(params.did, params.limit);
            if (!txns.length) return textResult("No transactions found");
            return jsonResult(txns);
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createFairTool(client: ImajinClient) {
  return {
    name: "imajin_fair",
    label: "Imajin .fair Attribution",
    description:
      "Inspect .fair attribution manifests — who made what and who gets paid. " +
      "Shows the complete breakdown of shares and fees for any transaction.",
    parameters: {
      type: "object" as const,
      properties: {
        transactionId: {
          type: "string" as const,
          description: "Transaction ID to inspect the .fair manifest for",
        },
      },
      required: ["transactionId"],
    },
    async execute(_id: string, params: { transactionId: string }): Promise<ToolResult> {
      try {
        const manifest = await client.getFairManifest(params.transactionId);
        if (!manifest)
          return textResult(`No .fair manifest found for transaction: ${params.transactionId}`);
        return jsonResult(manifest);
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createDiscoverTool(client: ImajinClient) {
  return {
    name: "imajin_discover",
    label: "Imajin Discovery",
    description:
      "Search the Imajin network for people, businesses, events, market items, communities, and stubs. " +
      "Optional type filter: person, business, community, event, market, stub.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string" as const,
          description: "Search query",
        },
        type: {
          type: "string" as const,
          enum: ["person", "business", "community", "event", "market", "stub"],
          description: "Filter by type (optional)",
        },
      },
      required: ["query"],
    },
    async execute(_id: string, params: { query: string; type?: string }): Promise<ToolResult> {
      try {
        const results = await client.search(params.query, params.type);
        if (!results.length) return textResult(`No results found for: ${params.query}`);
        return jsonResult(truncateResults(results));
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createMediaTool(client: ImajinClient) {
  return {
    name: "imajin_media",
    label: "Imajin Media",
    description:
      "Upload, list, and retrieve media assets on the Imajin network. " +
      "Actions: upload (upload a file from a local path), list (list assets with optional filters), " +
      "get (get a single asset by ID).",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["upload", "list", "get"],
          description: "Action to perform",
        },
        path: {
          type: "string" as const,
          description: "Local file path to upload (for upload action)",
        },
        filename: {
          type: "string" as const,
          description: "Filename for the upload (defaults to basename of path)",
        },
        mimeType: {
          type: "string" as const,
          description: "MIME type (for upload, auto-detected from extension if omitted)",
        },
        context: {
          type: "string" as const,
          enum: ["profile", "chat", "events", "market", "bugs", "voice"],
          description: "Upload context — determines access level and folder (for upload)",
        },
        assetId: {
          type: "string" as const,
          description: "Asset ID to retrieve (for get action)",
        },
        search: {
          type: "string" as const,
          description: "Search term for filtering assets (for list action)",
        },
        type: {
          type: "string" as const,
          enum: ["image", "audio", "video", "text"],
          description: "Filter by media type (for list action)",
        },
        limit: {
          type: "number" as const,
          description: "Max results to return (for list, default 20)",
        },
      },
      required: ["action"],
    },
    async execute(
      _id: string,
      params: {
        action: string;
        path?: string;
        filename?: string;
        mimeType?: string;
        context?: string;
        assetId?: string;
        search?: string;
        type?: string;
        limit?: number;
      },
    ): Promise<ToolResult> {
      try {
        switch (params.action) {
          case "upload": {
            if (!params.path) return errorResult("'path' is required for upload");
            const buffer = Buffer.from(await readFile(params.path));
            const basename = params.path.split("/").pop() || "upload";
            const filename = params.filename || basename;
            const mime = params.mimeType || guessMime(filename);
            const ctx = params.context ? { app: params.context } : undefined;
            const asset = await client.uploadMedia(buffer, filename, mime, ctx);
            return jsonResult(asset);
          }
          case "list": {
            const result = await client.listMedia({
              search: params.search,
              type: params.type,
              limit: params.limit || 20,
            });
            if (!result.assets.length) return textResult("No media assets found");
            return jsonResult({ count: result.count, assets: truncateResults(result.assets) });
          }
          case "get": {
            if (!params.assetId) return errorResult("'assetId' is required for get");
            const asset = await client.getMedia(params.assetId);
            if (!asset) return textResult(`Asset not found: ${params.assetId}`);
            return jsonResult(asset);
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

// --- MIME type inference from file extension ---

const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
};

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  return EXT_MIME[ext] || "application/octet-stream";
}

// --- Connections tool ---

export function createConnectionsTool(client: ImajinClient) {
  return {
    name: "imajin_connections",
    label: "Imajin Connections",
    description:
      "Manage connections and invites on the Imajin network. " +
      "Actions: list_invites (see pending/accepted invites and quota), " +
      "create_invite (generate a shareable invite link or send an email invite), " +
      "connections (list trust graph connections for a DID).",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["list_invites", "create_invite", "connections"],
          description: "Action to perform",
        },
        did: {
          type: "string" as const,
          description: "DID to list connections for (connections action)",
        },
        delivery: {
          type: "string" as const,
          enum: ["link", "email"],
          description: "Invite delivery method (default: link)",
        },
        toEmail: {
          type: "string" as const,
          description: "Recipient email address (for email delivery)",
        },
        note: {
          type: "string" as const,
          description: "Personal note to include with the invite",
        },
        maxUses: {
          type: "number" as const,
          description: "Maximum number of times the invite link can be used (default: 1)",
        },
      },
      required: ["action"],
    },
    async execute(
      _id: string,
      params: {
        action: string;
        did?: string;
        delivery?: "link" | "email";
        toEmail?: string;
        note?: string;
        maxUses?: number;
      },
    ): Promise<ToolResult> {
      try {
        switch (params.action) {
          case "list_invites": {
            const result = await client.listInvites();
            if (!result.invites.length) {
              return textResult(
                `No invites yet. Tier: ${result.tier}, Remaining: ${result.remaining ?? "unlimited"}`,
              );
            }
            return jsonResult({
              tier: result.tier,
              limit: result.limit,
              pending: result.pending,
              remaining: result.remaining,
              invites: truncateResults(result.invites),
            });
          }
          case "create_invite": {
            if (params.delivery === "email" && !params.toEmail) {
              return errorResult("'toEmail' is required for email invites");
            }
            const result = await client.createInvite({
              delivery: params.delivery,
              toEmail: params.toEmail,
              note: params.note,
              maxUses: params.maxUses,
            });
            return jsonResult({
              url: result.url,
              invite: result.invite,
              remaining: result.remaining,
            });
          }
          case "connections": {
            const connections = await client.getConnections();
            if (!connections.length) return textResult("No connections yet.");
            return jsonResult(truncateResults(connections));
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

// --- Chat tool ---

export function createChatTool(chat: ImajinChat) {
  return {
    name: "imajin_chat",
    label: "Imajin Chat",
    description:
      "Send and receive messages on the Imajin network. " +
      "Actions: send_dm (send a direct message to a DID or handle), " +
      "get_dms (get recent DMs with a specific person), " +
      "list_conversations (list all conversations), " +
      "send (send to any conversation DID), " +
      "get_messages (get messages from any conversation).",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["send_dm", "get_dms", "list_conversations", "send", "get_messages"],
          description: "Action to perform",
        },
        to: {
          type: "string" as const,
          description: "Recipient DID for send_dm, or conversation DID for send/get_messages",
        },
        text: {
          type: "string" as const,
          description: "Message text to send",
        },
        replyTo: {
          type: "string" as const,
          description: "Message ID to reply to (optional)",
        },
        limit: {
          type: "number" as const,
          description: "Number of messages to fetch (default 20)",
        },
      },
      required: ["action"],
    },
    async execute(
      _id: string,
      params: {
        action: string;
        to?: string;
        text?: string;
        replyTo?: string;
        limit?: number;
      },
    ): Promise<ToolResult> {
      try {
        switch (params.action) {
          case "send_dm": {
            if (!params.to) return errorResult("'to' (recipient DID) is required");
            if (!params.text) return errorResult("'text' is required");
            const msg = await chat.sendDM(params.to, params.text, params.replyTo);
            return jsonResult(msg);
          }
          case "get_dms": {
            if (!params.to) return errorResult("'to' (recipient DID) is required");
            const result = await chat.getDMs(params.to, { limit: params.limit || 20 });
            if (!result.messages.length) return textResult("No DMs found");
            return jsonResult({
              messages: truncateResults(result.messages),
              hasMore: result.hasMore,
            });
          }
          case "list_conversations": {
            const convs = await chat.listConversations();
            if (!convs.length) return textResult("No conversations found");
            return jsonResult(truncateResults(convs));
          }
          case "send": {
            if (!params.to) return errorResult("'to' (conversation DID) is required");
            if (!params.text) return errorResult("'text' is required");
            const msg = await chat.sendMessage(params.to, params.text, {
              replyToMessageId: params.replyTo,
            });
            return jsonResult(msg);
          }
          case "get_messages": {
            if (!params.to) return errorResult("'to' (conversation DID) is required");
            const result = await chat.getMessages(params.to, { limit: params.limit || 20 });
            if (!result.messages.length) return textResult("No messages found");
            return jsonResult({
              messages: truncateResults(result.messages),
              hasMore: result.hasMore,
            });
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
