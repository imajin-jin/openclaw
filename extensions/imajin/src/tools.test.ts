import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ImajinClient } from "./client.js";
import { createMediaTool } from "./tools.js";

function makeMockClient(): ImajinClient {
  return {
    uploadMedia: vi.fn(),
    listMedia: vi.fn(),
    getMedia: vi.fn(),
    moveMediaToFolder: vi.fn(),
    setMediaAccess: vi.fn(),
    grantMediaAccess: vi.fn(),
    publishMediaAsArticle: vi.fn(),
  } as unknown as ImajinClient;
}

describe("imajin_media tool", () => {
  let client: ReturnType<typeof makeMockClient>;
  let tool: ReturnType<typeof createMediaTool>;

  beforeEach(() => {
    client = makeMockClient();
    tool = createMediaTool(client as unknown as ImajinClient);
  });

  it("supports move-to-folder action", async () => {
    vi.mocked(client.moveMediaToFolder).mockResolvedValue({
      assetId: "asset_123",
      folderIds: ["folder_456"],
    });
    const result = await tool.execute("1", {
      action: "move-to-folder",
      assetId: "asset_123",
      folderId: "folder_456",
    });
    expect(client.moveMediaToFolder).toHaveBeenCalledWith("asset_123", "folder_456");
    expect(JSON.parse(result.content[0].text)).toEqual({
      assetId: "asset_123",
      folderIds: ["folder_456"],
    });
  });

  it("move-to-folder requires assetId and folderId", async () => {
    const r1 = await tool.execute("1", { action: "move-to-folder" } as never);
    expect(r1.content[0].text).toMatch(/assetId.*required/i);

    const r2 = await tool.execute("1", { action: "move-to-folder", assetId: "a" } as never);
    expect(r2.content[0].text).toMatch(/folderId.*required/i);
  });

  it("supports set-access action", async () => {
    vi.mocked(client.setMediaAccess).mockResolvedValue({
      id: "asset_123",
      access: { type: "public" },
    } as never);
    const result = await tool.execute("1", {
      action: "set-access",
      assetId: "asset_123",
      access: "public",
    });
    expect(client.setMediaAccess).toHaveBeenCalledWith("asset_123", "public");
    expect(JSON.parse(result.content[0].text).access.type).toBe("public");
  });

  it("set-access requires assetId and access", async () => {
    const r1 = await tool.execute("1", { action: "set-access" } as never);
    expect(r1.content[0].text).toMatch(/assetId.*required/i);

    const r2 = await tool.execute("1", { action: "set-access", assetId: "a" } as never);
    expect(r2.content[0].text).toMatch(/access.*required/i);
  });

  it("supports grant-access action", async () => {
    vi.mocked(client.grantMediaAccess).mockResolvedValue({
      id: "asset_123",
      allowedDids: ["did:imajin:other"],
    } as never);
    const result = await tool.execute("1", {
      action: "grant-access",
      assetId: "asset_123",
      did: "did:imajin:other",
    });
    expect(client.grantMediaAccess).toHaveBeenCalledWith("asset_123", "did:imajin:other");
    expect(JSON.parse(result.content[0].text).allowedDids).toContain("did:imajin:other");
  });

  it("grant-access requires assetId and did", async () => {
    const r1 = await tool.execute("1", { action: "grant-access" } as never);
    expect(r1.content[0].text).toMatch(/assetId.*required/i);

    const r2 = await tool.execute("1", { action: "grant-access", assetId: "a" } as never);
    expect(r2.content[0].text).toMatch(/did.*required/i);
  });

  it("supports publish-as-article action", async () => {
    vi.mocked(client.publishMediaAsArticle).mockResolvedValue({
      id: "asset_123",
      metadata: { article: { slug: "hello", title: "Hello World" } },
    } as never);
    const result = await tool.execute("1", {
      action: "publish-as-article",
      assetId: "asset_123",
      slug: "hello",
      title: "Hello World",
      subtitle: "A test article",
      description: "Desc",
      status: "DRAFT",
    });
    expect(client.publishMediaAsArticle).toHaveBeenCalledWith("asset_123", {
      slug: "hello",
      title: "Hello World",
      subtitle: "A test article",
      description: "Desc",
      status: "DRAFT",
    });
    expect(JSON.parse(result.content[0].text).metadata.article.slug).toBe("hello");
  });

  it("publish-as-article defaults status to POSTED", async () => {
    vi.mocked(client.publishMediaAsArticle).mockResolvedValue({ id: "asset_123" } as never);
    await tool.execute("1", {
      action: "publish-as-article",
      assetId: "asset_123",
      slug: "hello",
      title: "Hello",
    });
    expect(client.publishMediaAsArticle).toHaveBeenCalledWith("asset_123", {
      slug: "hello",
      title: "Hello",
      status: "POSTED",
    });
  });

  it("publish-as-article requires assetId, slug, and title", async () => {
    const r1 = await tool.execute("1", { action: "publish-as-article" } as never);
    expect(r1.content[0].text).toMatch(/assetId.*required/i);

    const r2 = await tool.execute("1", { action: "publish-as-article", assetId: "a" } as never);
    expect(r2.content[0].text).toMatch(/slug.*required/i);

    const r3 = await tool.execute("1", {
      action: "publish-as-article",
      assetId: "a",
      slug: "s",
    } as never);
    expect(r3.content[0].text).toMatch(/title.*required/i);
  });

  it("includes document, outreach, article, essay in context enum", () => {
    const contextProp = tool.parameters.properties.context;
    expect(contextProp.enum).toContain("document");
    expect(contextProp.enum).toContain("outreach");
    expect(contextProp.enum).toContain("article");
    expect(contextProp.enum).toContain("essay");
  });
});
