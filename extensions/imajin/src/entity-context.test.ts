import { describe, it, expect, vi } from "vitest";
import type { ImajinClient } from "./client.js";
import { createEntityContextHook } from "./entity-context.js";

function mockClient(lookup: (q: string) => Promise<unknown>): {
  client: ImajinClient;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(lookup);
  const client = { lookupIdentity: spy } as unknown as ImajinClient;
  return { client, spy };
}

function userMessage(text: string) {
  return { role: "user", content: text };
}

describe("entity-context hook", () => {
  it("returns undefined when no handles are mentioned", async () => {
    const { client, spy } = mockClient(async () => null);
    const hook = createEntityContextHook(client);

    const result = await hook({
      prompt: "hello world",
      messages: [userMessage("hello world")],
    });

    expect(result).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolves a single @handle and injects prependContext", async () => {
    const { client, spy } = mockClient(async (q) => ({
      did: `did:imajin:${q}-did`,
      scope: "actor",
      subtype: "human",
      tier: "established",
      name: "Yancey Smith",
    }));
    const hook = createEntityContextHook(client);

    const result = await hook({
      prompt: "do you know @yancey?",
      messages: [userMessage("do you know @yancey?")],
    });

    expect(spy).toHaveBeenCalledWith("yancey");
    expect(result?.prependContext).toContain("@yancey");
    expect(result?.prependContext).toContain("did:imajin:yancey-did");
    expect(result?.prependContext).toContain("actor/human");
    expect(result?.prependContext).toContain("tier=established");
  });

  it("dedupes handles within a single turn", async () => {
    const { client, spy } = mockClient(async () => ({
      did: "did:imajin:abc",
      scope: "actor",
    }));
    const hook = createEntityContextHook(client);

    await hook({
      prompt: "@yancey told @yancey about @YANCEY",
      messages: [userMessage("@yancey told @yancey about @YANCEY")],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("yancey");
  });

  it("caches resolutions across turns", async () => {
    const { client, spy } = mockClient(async () => ({ did: "did:imajin:abc" }));
    const hook = createEntityContextHook(client);

    await hook({
      prompt: "@yancey",
      messages: [userMessage("@yancey")],
    });
    await hook({
      prompt: "@yancey again",
      messages: [userMessage("@yancey again")],
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("respects the lookup cap per turn", async () => {
    const { client, spy } = mockClient(async () => ({ did: "did:imajin:abc" }));
    const hook = createEntityContextHook(client, { maxLookupsPerTurn: 2 });

    await hook({
      prompt: "@a @b @c @d @e @f",
      messages: [userMessage("@a @b @c @d @e @f")],
    });

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("swallows lookup errors silently", async () => {
    const warn = vi.fn();
    const { client } = mockClient(async () => {
      throw new Error("network down");
    });
    const hook = createEntityContextHook(client, { logger: { warn } });

    const result = await hook({
      prompt: "@yancey",
      messages: [userMessage("@yancey")],
    });

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("returns undefined when no handles resolve", async () => {
    const { client } = mockClient(async () => null);
    const hook = createEntityContextHook(client);

    const result = await hook({
      prompt: "@nobody",
      messages: [userMessage("@nobody")],
    });

    expect(result).toBeUndefined();
  });

  it("falls back to event.prompt when messages have no user turn", async () => {
    const { client, spy } = mockClient(async () => ({ did: "did:imajin:abc" }));
    const hook = createEntityContextHook(client);

    await hook({
      prompt: "ping @yancey",
      messages: [],
    });

    expect(spy).toHaveBeenCalledWith("yancey");
  });
});
