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
            const connections = await client.getConnections(params.query);
            if (!connections.length) return textResult(`No connections found for: ${params.query}`);
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
        if (!manifest) return textResult(`No .fair manifest found for transaction: ${params.transactionId}`);
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
    async execute(
      _id: string,
      params: { query: string; type?: string },
    ): Promise<ToolResult> {
      try {
        const results = await client.search(params.query, params.type);
        if (!results.length) return textResult(`No results found for: ${params.query}`);
        return jsonResult(results);
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
