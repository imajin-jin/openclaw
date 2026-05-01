/**
 * Imajin Node API client.
 *
 * Authenticates via Ed25519 challenge-response (no API keys).
 * Signs challenges with the agent's keypair to get a session cookie.
 */

import { readFile } from "node:fs/promises";

export interface ImajinClientConfig {
  nodeUrl: string;
  did?: string;
  keypairPath?: string;
}

interface Keypair {
  did: string;
  publicKey: string;
  publicKeyHex: string;
  privateKey: string;
}

export interface ImajinIdentity {
  did: string;
  handle?: string;
  scope: string;
  subtype: string;
  displayName?: string;
  tier?: string;
}

export interface ImajinAttestation {
  id: string;
  type: string;
  issuer: string;
  subject: string;
  claim: Record<string, unknown>;
  signature: string;
  timestamp: string;
}

export interface ImajinTransaction {
  id: string;
  amount: number;
  currency: string;
  from: string;
  to: string;
  fairManifest?: FairManifest;
  timestamp: string;
}

export interface FairManifest {
  shares: Array<{
    did: string;
    label: string;
    amount: number;
    percentage: number;
  }>;
  fees: Array<{
    type: string;
    amount: number;
    recipient: string;
  }>;
}

export interface SearchResult {
  did: string;
  type: string;
  displayName?: string;
  handle?: string;
  scope: string;
  subtype: string;
  relevance: number;
}

export interface MediaAsset {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  hash: string;
  createdAt: string;
  classification?: string;
}

export class ImajinClient {
  private baseUrl: string;
  private did?: string;
  private keypairPath?: string;
  private keypair?: Keypair;
  private sessionCookie?: string;
  private sessionExpiresAt?: number;

  constructor(config: ImajinClientConfig) {
    this.baseUrl = config.nodeUrl.replace(/\/$/, "");
    this.did = config.did;
    this.keypairPath = config.keypairPath;
  }

  // --- Auth ---

  /**
   * Load the Ed25519 keypair from the configured path.
   */
  private async loadKeypair(): Promise<Keypair> {
    if (this.keypair) return this.keypair;
    if (!this.keypairPath) {
      throw new Error("No keypairPath configured — cannot authenticate");
    }
    const raw = await readFile(this.keypairPath, "utf-8");
    this.keypair = JSON.parse(raw) as Keypair;
    // Derive DID from keypair if not explicitly set
    if (!this.did) {
      this.did = this.keypair.did;
    }
    return this.keypair;
  }

  /**
   * Sign a hex-encoded challenge with the agent's Ed25519 private key.
   * Uses @noble/ed25519 (same as the Imajin server).
   */
  private async signChallenge(challengeHex: string, privateKeyHex: string): Promise<string> {
    // Dynamic import — @noble/ed25519 is ESM
    const ed = await import("@noble/ed25519");
    const { sha512 } = await import("@noble/hashes/sha2.js");

    // Configure sha512 sync (same as server)
    ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

    const messageBytes = new TextEncoder().encode(challengeHex);
    const privKeyBytes = hexToBytes(privateKeyHex);
    const signature = await ed.signAsync(messageBytes, privKeyBytes);
    return bytesToHex(signature);
  }

  /**
   * Authenticate with the Imajin node via challenge-response.
   * 1. POST /auth/api/login/challenge with our DID
   * 2. Sign the challenge with our private key
   * 3. POST /auth/api/login/verify with challengeId + signature
   * 4. Extract session cookie from response
   */
  async authenticate(): Promise<void> {
    // Skip if session is still valid (with 5 min buffer)
    if (this.sessionCookie && this.sessionExpiresAt && Date.now() < this.sessionExpiresAt - 300_000) {
      return;
    }

    const keypair = await this.loadKeypair();

    // Step 1: Request challenge
    const challengeRes = await fetch(`${this.baseUrl}/auth/api/login/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: keypair.did }),
    });

    if (!challengeRes.ok) {
      const err = await challengeRes.text();
      throw new Error(`Auth challenge failed (${challengeRes.status}): ${err}`);
    }

    const { challengeId, challenge, expiresAt } = (await challengeRes.json()) as {
      challengeId: string;
      challenge: string;
      expiresAt: string;
    };

    // Step 2: Sign the challenge
    const signature = await this.signChallenge(challenge, keypair.privateKey);

    // Step 3: Verify signature
    const verifyRes = await fetch(`${this.baseUrl}/auth/api/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, signature }),
    });

    if (!verifyRes.ok) {
      const err = await verifyRes.text();
      throw new Error(`Auth verify failed (${verifyRes.status}): ${err}`);
    }

    // Step 4: Extract session cookie
    const setCookie = verifyRes.headers.get("set-cookie");
    if (setCookie) {
      // Extract the session token from set-cookie header
      const match = setCookie.match(/([^=]+)=([^;]+)/);
      if (match) {
        this.sessionCookie = `${match[1]}=${match[2]}`;
      }
    }

    // Session expires when the challenge would have expired (5 min),
    // but the JWT likely has a longer TTL. Refresh conservatively.
    this.sessionExpiresAt = new Date(expiresAt).getTime() + 3600_000; // assume 1hr session
  }

  /**
   * Ensure we're authenticated, then return headers with session cookie.
   */
  private async authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.keypairPath) {
      await this.authenticate();
      if (this.sessionCookie) {
        headers["Cookie"] = this.sessionCookie;
      }
    }
    if (this.did) {
      headers["X-Agent-DID"] = this.did;
    }
    return headers;
  }

  // --- Identity ---

  async lookupIdentity(query: string): Promise<ImajinIdentity | null> {
    const res = await this.get(`/registry/api/identity/lookup?q=${encodeURIComponent(query)}`);
    return (res as Record<string, unknown>).identity as ImajinIdentity ?? null;
  }

  async getIdentity(did: string): Promise<ImajinIdentity | null> {
    const res = await this.get(`/registry/api/identity/${encodeURIComponent(did)}`);
    return (res as Record<string, unknown>).identity as ImajinIdentity ?? null;
  }

  async getConnections(did: string): Promise<ImajinIdentity[]> {
    const res = await this.get(`/connections/api/connections/${encodeURIComponent(did)}`);
    return ((res as Record<string, unknown>).connections as ImajinIdentity[]) ?? [];
  }

  // --- Attestation ---

  async getAttestations(did: string): Promise<ImajinAttestation[]> {
    const res = await this.get(`/registry/api/attestations?subject=${encodeURIComponent(did)}`);
    return ((res as Record<string, unknown>).attestations as ImajinAttestation[]) ?? [];
  }

  async createAttestation(
    attestation: Omit<ImajinAttestation, "id" | "signature" | "timestamp">,
  ): Promise<ImajinAttestation> {
    return this.post("/registry/api/attestations", attestation) as Promise<ImajinAttestation>;
  }

  // --- Settlement ---

  async getBalance(did?: string): Promise<{ mjnx: number; mjn: number }> {
    const target = did ?? this.did;
    if (!target) throw new Error("No DID available for balance check");
    const res = await this.get(`/pay/api/balance/${encodeURIComponent(target)}`);
    return ((res as Record<string, unknown>).balance as { mjnx: number; mjn: number }) ?? { mjnx: 0, mjn: 0 };
  }

  async getTransactions(did?: string, limit = 20): Promise<ImajinTransaction[]> {
    const target = did ?? this.did;
    if (!target) throw new Error("No DID available for transaction lookup");
    const res = await this.get(`/pay/api/transactions/${encodeURIComponent(target)}?limit=${limit}`);
    return ((res as Record<string, unknown>).transactions as ImajinTransaction[]) ?? [];
  }

  // --- Discovery ---

  async search(query: string, type?: string): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (type) params.set("type", type);
    const res = await this.get(`/registry/api/search?${params}`);
    return ((res as Record<string, unknown>).results as SearchResult[]) ?? [];
  }

  // --- Fair ---

  async getFairManifest(transactionId: string): Promise<FairManifest | null> {
    const res = await this.get(`/pay/api/fair/${encodeURIComponent(transactionId)}`);
    return ((res as Record<string, unknown>).manifest as FairManifest) ?? null;
  }

  // --- Media ---

  /**
   * Upload a file to the Imajin media service.
   * Returns the asset metadata including public URL.
   */
  async uploadMedia(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
    context?: { app?: string; feature?: string; access?: string },
  ): Promise<MediaAsset> {
    const headers = await this.authHeaders();
    // Remove Accept header — multipart needs different handling
    delete headers["Accept"];

    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: mimeType });
    formData.append("file", blob, filename);
    if (context) {
      formData.append("context", JSON.stringify(context));
    }

    const res = await fetch(`${this.baseUrl}/media/api/assets`, {
      method: "POST",
      headers: {
        Cookie: headers["Cookie"] || "",
        ...(headers["X-Agent-DID"] ? { "X-Agent-DID": headers["X-Agent-DID"] } : {}),
      },
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`Media upload failed (${res.status}): ${await res.text()}`);
    }

    return (await res.json()) as MediaAsset;
  }

  /**
   * List media assets for the authenticated agent (or a specific DID).
   */
  async listMedia(opts?: {
    search?: string;
    type?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ assets: MediaAsset[]; count: number }> {
    const params = new URLSearchParams();
    if (opts?.search) params.set("search", opts.search);
    if (opts?.type) params.set("type", opts.type);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const res = await this.get(`/media/api/assets?${params}`);
    const data = res as Record<string, unknown>;
    return {
      assets: (data.assets as MediaAsset[]) ?? [],
      count: (data.count as number) ?? 0,
    };
  }

  /**
   * Get a single media asset by ID.
   */
  async getMedia(assetId: string): Promise<MediaAsset | null> {
    try {
      const res = await this.get(`/media/api/assets/${encodeURIComponent(assetId)}`);
      return res as unknown as MediaAsset;
    } catch {
      return null;
    }
  }

  // --- HTTP helpers (public for chat/other modules) ---

  async getRaw(path: string): Promise<Record<string, unknown>> {
    return this.get(path);
  }

  async postRaw(path: string, body: unknown): Promise<Record<string, unknown>> {
    return this.post(path, body);
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const headers = await this.authHeaders();
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    if (!res.ok) {
      throw new Error(`Imajin API ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const headers = await this.authHeaders();
    headers["Content-Type"] = "application/json";
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Imajin API ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}

// --- Hex utilities (same as Imajin server) ---

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
