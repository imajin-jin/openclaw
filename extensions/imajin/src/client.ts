/**
 * Imajin Node API client.
 *
 * Handles authenticated requests to an Imajin node.
 * Signs requests with the agent's Ed25519 keypair when available.
 */

export interface ImajinClientConfig {
  nodeUrl: string;
  did?: string;
  keypairPath?: string;
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

export class ImajinClient {
  private baseUrl: string;
  private did?: string;
  private keypairPath?: string;

  constructor(config: ImajinClientConfig) {
    this.baseUrl = config.nodeUrl.replace(/\/$/, "");
    this.did = config.did;
    this.keypairPath = config.keypairPath;
  }

  // --- Identity ---

  async lookupIdentity(query: string): Promise<ImajinIdentity | null> {
    const res = await this.get(
      `/registry/api/identity/lookup?q=${encodeURIComponent(query)}`,
    );
    return res.identity ?? null;
  }

  async getIdentity(did: string): Promise<ImajinIdentity | null> {
    const res = await this.get(
      `/registry/api/identity/${encodeURIComponent(did)}`,
    );
    return res.identity ?? null;
  }

  async getConnections(did: string): Promise<ImajinIdentity[]> {
    const res = await this.get(
      `/connections/api/connections/${encodeURIComponent(did)}`,
    );
    return res.connections ?? [];
  }

  // --- Attestation ---

  async getAttestations(did: string): Promise<ImajinAttestation[]> {
    const res = await this.get(
      `/registry/api/attestations?subject=${encodeURIComponent(did)}`,
    );
    return res.attestations ?? [];
  }

  async createAttestation(
    attestation: Omit<ImajinAttestation, "id" | "signature" | "timestamp">,
  ): Promise<ImajinAttestation> {
    return this.post("/registry/api/attestations", attestation);
  }

  // --- Settlement ---

  async getBalance(did?: string): Promise<{ mjnx: number; mjn: number }> {
    const target = did ?? this.did;
    const res = await this.get(
      `/pay/api/balance/${encodeURIComponent(target!)}`,
    );
    return res.balance ?? { mjnx: 0, mjn: 0 };
  }

  async getTransactions(
    did?: string,
    limit = 20,
  ): Promise<ImajinTransaction[]> {
    const target = did ?? this.did;
    const res = await this.get(
      `/pay/api/transactions/${encodeURIComponent(target!)}?limit=${limit}`,
    );
    return res.transactions ?? [];
  }

  // --- Discovery ---

  async search(query: string, type?: string): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (type) params.set("type", type);
    const res = await this.get(`/registry/api/search?${params}`);
    return res.results ?? [];
  }

  // --- Fair ---

  async getFairManifest(transactionId: string): Promise<FairManifest | null> {
    const res = await this.get(
      `/pay/api/fair/${encodeURIComponent(transactionId)}`,
    );
    return res.manifest ?? null;
  }

  // --- HTTP helpers ---

  private async get(path: string): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.did) {
      headers["X-Agent-DID"] = this.did;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Imajin API ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.did) {
      headers["X-Agent-DID"] = this.did;
    }
    const res = await fetch(url, {
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
