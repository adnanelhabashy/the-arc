import { describe, expect, it } from "vitest";
import type { AccountPoolRpcClient } from "../src/arc-account/account-pool-source.js";
import { ArcPoolUsageSource } from "../src/arc-usage/pool-source.js";
import { ArcUsageError } from "../src/arc-usage/types.js";

// Normalization tests for the Account Pool usage adapter, using wire shapes
// from the real provider-usage.v1 contract
// (plugins/account-pool/src/usage-contract.ts).

const RESET_ISO = "2026-09-19T12:00:00.000Z";

function fakeRpc(fixture: {
  list: unknown;
  fetch?: Record<string, unknown>;
}): { rpc: AccountPoolRpcClient; calls: { method: string; input: unknown }[] } {
  const calls: { method: string; input: unknown }[] = [];
  return {
    calls,
    rpc: {
      async call(method: string, input: unknown): Promise<unknown> {
        calls.push({ method, input });
        if (method === "provider-usage.v1.listResources") return fixture.list;
        const resourceId = (input as { resourceId: string }).resourceId;
        const payload = fixture.fetch?.[resourceId];
        if (payload === undefined) throw new Error("unknown resource");
        return payload;
      },
    },
  };
}

function listed(
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    label: "Account Pooler",
    resources: [
      {
        accountKey: "openai:chatgpt:acc-1",
        id: "acct-uuid-1",
        providerId: "codex",
        label: "adnan@example.com",
        scope: { kind: "shared" },
        ...overrides,
      },
    ],
  };
}

function okUsage(overrides: Record<string, unknown> = {}): unknown {
  return {
    accountKey: "openai:chatgpt:acc-1",
    observedAt: 1_000,
    usage: {
      status: "ok",
      plan: { id: "plus", multiplier: null },
      accountEmail: "adnan@example.com",
      planLabel: "Plus",
      windows: [
        {
          kind: "five-hour",
          id: "five-hour",
          label: "Five-hour limit",
          usedPercent: 24,
          resetsAt: RESET_ISO,
          model: null,
          cost: null,
        },
        {
          kind: "weekly",
          id: "weekly",
          label: "Weekly limit",
          usedPercent: 51,
          resetsAt: null,
          model: null,
          cost: { usedUsdCents: 120, limitUsdCents: 500 },
        },
      ],
      ...overrides,
    },
  };
}

describe("ArcPoolUsageSource", () => {
  it("lists resources as cheap metadata without usage windows", async () => {
    const { rpc, calls } = fakeRpc({ list: listed() });
    const source = new ArcPoolUsageSource({ rpc });
    const resources = await source.list();
    expect(resources).toHaveLength(1);
    const resource = resources[0]!;
    expect(resource.id).toBe("pool:openai:acct-uuid-1");
    expect(resource.accountKey).toBe("openai:chatgpt:acc-1");
    expect(resource.providerFamily).toBe("openai");
    expect(resource.providerLabel).toBe("ChatGPT");
    expect(resource.agentIds).toEqual(["codex"]);
    expect(resource.accountSourceId).toBe("acct-uuid-1");
    expect(resource.windows).toEqual([]);
    expect(resource.status).toBe("unknown");
    expect(calls.every((call) => call.method === "provider-usage.v1.listResources")).toBe(
      true,
    );
  });

  it("maps claude accounts to the Claude Code agent with anthropic identity", async () => {
    const { rpc } = fakeRpc({
      list: listed({
        accountKey: "anthropic:account:uuid-9",
        providerId: "claude-code",
        id: "acct-uuid-9",
      }),
    });
    const resources = await new ArcPoolUsageSource({ rpc }).list();
    expect(resources[0]!.agentIds).toEqual(["claude-code"]);
    expect(resources[0]!.providerFamily).toBe("anthropic");
    expect(resources[0]!.accountKey).toBe("anthropic:account:uuid-9");
  });

  it("normalizes five-hour and weekly windows with reset timestamps", async () => {
    const { rpc } = fakeRpc({
      list: listed(),
      fetch: { "acct-uuid-1": okUsage() },
    });
    const source = new ArcPoolUsageSource({ rpc });
    const resource = await source.fetch("pool:openai:acct-uuid-1", false);
    expect(resource.status).toBe("available");
    expect(resource.observedAt).toBe(1_000);
    expect(resource.fetchedAt).not.toBeNull();
    expect(resource.planLabel).toBe("Plus");
    expect(resource.accountEmail).toBe("adnan@example.com");
    const fiveHour = resource.windows.find((w) => w.kind === "five-hour")!;
    expect(fiveHour.usedPercent).toBe(24);
    expect(fiveHour.remainingPercent).toBe(76);
    expect(fiveHour.resetsAt).toBe(Date.parse(RESET_ISO));
    const weekly = resource.windows.find((w) => w.kind === "weekly")!;
    expect(weekly.usedPercent).toBe(51);
    // A missing reset timestamp stays null — never guessed.
    expect(weekly.resetsAt).toBeNull();
    // A reported cost stays a real usd amount; percentages are untouched.
    expect(weekly.unit).toBe("usd");
    expect(weekly.usedAmount).toBe(120);
    expect(weekly.limitAmount).toBe(500);
  });

  it("keeps an ok measurement with zero windows honest (no fabricated data)", async () => {
    const { rpc } = fakeRpc({
      list: listed(),
      fetch: { "acct-uuid-1": okUsage({ windows: [] }) },
    });
    const resource = await new ArcPoolUsageSource({ rpc }).fetch(
      "pool:openai:acct-uuid-1",
      false,
    );
    expect(resource.status).toBe("available");
    expect(resource.windows).toEqual([]);
  });

  it.each(["unauthenticated", "expired"] as const)(
    "maps %s to unavailable/not-connected, never zero usage",
    async (status) => {
      const { rpc } = fakeRpc({
        list: listed(),
        fetch: {
          "acct-uuid-1": {
            accountKey: "openai:chatgpt:acc-1",
            observedAt: null,
            usage: {
              status,
              plan: null,
              accountEmail: null,
              planLabel: null,
            },
          },
        },
      });
      const resource = await new ArcPoolUsageSource({ rpc }).fetch(
        "pool:openai:acct-uuid-1",
        true,
      );
      expect(resource.status).toBe("unavailable");
      expect(resource.unavailableReason).toBe("not-connected");
      expect(resource.windows).toEqual([]);
      expect(resource.observedAt).toBeNull();
      expect(
        resource.windows.every((w) => w.usedPercent === null),
      ).toBe(true);
    },
  );

  it("maps not_installed to not-exposed (the provider CLI is missing, not the account), never zero usage", async () => {
    const { rpc } = fakeRpc({
      list: listed(),
      fetch: {
        "acct-uuid-1": {
          accountKey: "openai:chatgpt:acc-1",
          observedAt: null,
          usage: {
            status: "not_installed",
            plan: null,
            accountEmail: null,
            planLabel: null,
          },
        },
      },
    });
    const resource = await new ArcPoolUsageSource({ rpc }).fetch(
      "pool:openai:acct-uuid-1",
      true,
    );
    expect(resource.status).toBe("unavailable");
    expect(resource.unavailableReason).toBe("not-exposed");
    expect(resource.message).toContain("not installed");
    expect(resource.windows).toEqual([]);
    expect(resource.observedAt).toBeNull();
    expect(resource.windows.every((w) => w.usedPercent === null)).toBe(true);
  });

  it("maps error measurements to an error state without zeros", async () => {
    const { rpc } = fakeRpc({
      list: listed(),
      fetch: {
        "acct-uuid-1": {
          accountKey: "openai:chatgpt:acc-1",
          observedAt: null,
          usage: {
            status: "error",
            plan: null,
            accountEmail: null,
            planLabel: null,
            message: "boom",
          },
        },
      },
    });
    const resource = await new ArcPoolUsageSource({ rpc }).fetch(
      "pool:openai:acct-uuid-1",
      true,
    );
    expect(resource.status).toBe("error");
    expect(resource.message).toContain("Try refreshing");
    expect(resource.windows).toEqual([]);
  });

  it("throws usage-contract-invalid on a malformed payload", async () => {
    const { rpc } = fakeRpc({
      list: { resources: [{ id: 42 }] },
    });
    const source = new ArcPoolUsageSource({ rpc });
    await expect(source.list()).rejects.toMatchObject({
      code: "usage-contract-invalid",
    });
  });

  it("throws usage-resource-not-found for a removed resource", async () => {
    const { rpc } = fakeRpc({ list: listed() });
    const source = new ArcPoolUsageSource({ rpc });
    try {
      await source.fetch("pool:openai:gone", true);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ArcUsageError);
      expect((error as ArcUsageError).code).toBe("usage-resource-not-found");
    }
  });

  it("passes the refresh flag through to getResource", async () => {
    const { rpc, calls } = fakeRpc({
      list: listed(),
      fetch: { "acct-uuid-1": okUsage() },
    });
    await new ArcPoolUsageSource({ rpc }).fetch("pool:openai:acct-uuid-1", true);
    const fetchCall = calls.find(
      (call) => call.method === "provider-usage.v1.getResource",
    )!;
    expect(fetchCall.input).toEqual({
      resourceId: "acct-uuid-1",
      refresh: true,
    });
  });

  it("never carries credential material in serialized resources", async () => {
    const { rpc } = fakeRpc({
      list: listed(),
      fetch: {
        "acct-uuid-1": {
          ...(okUsage() as { usage: Record<string, unknown> }),
          usage: {
            ...(okUsage() as { usage: Record<string, unknown> }).usage,
            accountEmail: "adnan@example.com",
          },
        },
      },
    });
    const resource = await new ArcPoolUsageSource({ rpc }).fetch(
      "pool:openai:acct-uuid-1",
      true,
    );
    const serialized = JSON.stringify(resource);
    for (const pattern of [
      /access[_-]?token/iu,
      /refresh[_-]?token/iu,
      /api[_-]?key/iu,
      /authorization/iu,
      /bearer/iu,
      /secret/iu,
      /cookie/iu,
      /password/iu,
      /pkce/iu,
    ]) {
      expect(serialized).not.toMatch(pattern);
    }
  });
});
