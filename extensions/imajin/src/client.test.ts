import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ImajinClient } from "./client.js";

const BASE_URL = "https://test.imajin.ai";

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(response),
    json: async () => response,
    headers: new Headers(
      status === 200 ? { "set-cookie": "session=abc123; Path=/; HttpOnly" } : {},
    ),
  } as unknown as Response);
}

describe("ImajinClient media extensions", () => {
  let client: ImajinClient;

  beforeEach(() => {
    client = new ImajinClient({ nodeUrl: BASE_URL, did: "did:imajin:test" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moveMediaToFolder PUTs a single folderId array", async () => {
    global.fetch = mockFetch({ assetId: "asset_123", folderIds: ["folder_456"] });
    const result = await client.moveMediaToFolder("asset_123", "folder_456");
    expect(result).toEqual({ assetId: "asset_123", folderIds: ["folder_456"] });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const req = calls[calls.length - 1][0] as string;
    const init = calls[calls.length - 1][1] as RequestInit;
    expect(req).toBe(`${BASE_URL}/media/api/assets/asset_123/folders`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ folderIds: ["folder_456"] });
  });

  it("setMediaAccess PATCHes access level", async () => {
    global.fetch = mockFetch({ id: "asset_123", access: { type: "public" } });
    const result = await client.setMediaAccess("asset_123", "public");
    expect(result).toEqual({ id: "asset_123", access: { type: "public" } });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const req = calls[calls.length - 1][0] as string;
    const init = calls[calls.length - 1][1] as RequestInit;
    expect(req).toBe(`${BASE_URL}/media/api/assets/asset_123/access`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ access: "public" });
  });

  it("grantMediaAccess PATCHes a DID", async () => {
    global.fetch = mockFetch({ id: "asset_123", allowedDids: ["did:imajin:other"] });
    const result = await client.grantMediaAccess("asset_123", "did:imajin:other");
    expect(result).toEqual({ id: "asset_123", allowedDids: ["did:imajin:other"] });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const req = calls[calls.length - 1][0] as string;
    const init = calls[calls.length - 1][1] as RequestInit;
    expect(req).toBe(`${BASE_URL}/media/api/assets/asset_123/grants`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ did: "did:imajin:other" });
  });

  it("publishMediaAsArticle PATCHes article metadata", async () => {
    global.fetch = mockFetch({
      id: "asset_123",
      metadata: { article: { slug: "hello", title: "Hello" } },
    });
    const result = await client.publishMediaAsArticle("asset_123", {
      slug: "hello",
      title: "Hello",
      subtitle: "World",
      status: "DRAFT",
    });
    expect(result).toEqual({
      id: "asset_123",
      metadata: { article: { slug: "hello", title: "Hello" } },
    });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const req = calls[calls.length - 1][0] as string;
    const init = calls[calls.length - 1][1] as RequestInit;
    expect(req).toBe(`${BASE_URL}/media/api/assets/asset_123/article`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      article: { slug: "hello", title: "Hello", subtitle: "World", status: "DRAFT" },
    });
  });

  it("sends X-Acting-As header when actAs is configured", async () => {
    const actingClient = new ImajinClient({
      nodeUrl: BASE_URL,
      did: "did:imajin:agent",
      actAs: "did:imajin:user",
    });
    global.fetch = mockFetch({ ok: true });
    await actingClient.getRaw("/registry/api/search?q=test");

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const init = calls[calls.length - 1][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Acting-As"]).toBe("did:imajin:user");
    expect(headers["X-Agent-DID"]).toBe("did:imajin:agent");
  });
});
