import { describe, expect, it } from "vitest";
import type { ArcAccount } from "../src/arc-account/types.js";
import {
  ArcOmpUsageSource,
  type ArcOmpUsageGateway,
} from "../src/arc-usage/omp-source.js";

// Normalization tests for the OMP usage adapter, using wire shapes from the
// real 18.2.6 broker contract (packages/ai/src/auth-broker/wire-schemas.ts
// usageResponseSchema and DisabledCredentialsResponse).

const NOW = 1_000_000;

function ompAccount(overrides: Partial<ArcAccount> = {}): ArcAccount {
  return {
    id: "omp:openai-codex:7",
    sourceId: "7",
    sourceKind: "omp",
    providerFamily: "openai-codex",
    providerLabel: "OpenAI Codex",
    accountKey: "omp:openai-codex:chatgpt-acc-1",
    email: "adnan@example.com",
    planLabel: null,
    authState: "connected",
    enabled: true,
    availableThrough: ["omp"],
    observedAt: NOW,
    ...overrides,
  };
}

function usageWire(overrides: Record<string, unknown> = {}): unknown {
  return {
    generatedAt: NOW,
    reports: [
      {
        provider: "openai-codex",
        fetchedAt: 900,
        limits: [
          {
            id: "5h",
            label: "5 Hour",
            scope: { provider: "openai-codex", accountId: "chatgpt-acc-1" },
            window: {
              id: "5h",
              label: "5 Hour",
              durationMs: 18_000_000,
              resetsAt: 1_800_000,
            },
            amount: { usedFraction: 0.32, unit: "percent" },
            status: "ok",
          },
          {
            id: "7d",
            label: "7 Day",
            scope: { provider: "openai-codex", accountId: "chatgpt-acc-1" },
            window: { id: "7d", label: "7 Day", durationMs: 604_800_000 },
            amount: { used: 12, limit: 100, unit: "percent" },
          },
        ],
        metadata: { email: "adnan@example.com", planType: "pro" },
      },
    ],
    ...overrides,
  };
}

function fakeGateway(args: {
  accounts?: ArcAccount[];
  usage?: unknown;
  disabled?: unknown;
  failUsage?: boolean;
}): { gateway: ArcOmpUsageGateway } {
  return {
    gateway: {
      async fetchUsageSnapshot(): Promise<{ usage: unknown; disabled: unknown }> {
        if (args.failUsage === true) throw new Error("broker down");
        return { usage: args.usage ?? usageWire(), disabled: args.disabled ?? null };
      },
      async listOmpAccounts(): Promise<ArcAccount[]> {
        return args.accounts ?? [ompAccount()];
      },
    },
  };
}

describe("ArcOmpUsageSource", () => {
  it("maps reports to OMP-only resources with true fractions and window kinds", async () => {
    const { gateway } = fakeGateway({});
    const source = new ArcOmpUsageSource({ gateway, now: () => NOW });
    const resource = await source.fetch("omp:openai-codex:omp:openai-codex:7", true);
    expect(resource.status).toBe("available");
    expect(resource.agentIds).toEqual(["omp"]);
    expect(resource.accountKey).toBe("omp:openai-codex:chatgpt-acc-1");
    expect(resource.accountSourceId).toBe("omp:openai-codex:7");
    expect(resource.providerFamily).toBe("openai-codex");
    expect(resource.accountEmail).toBe("adnan@example.com");
    expect(resource.planLabel).toBe("pro");
    expect(resource.observedAt).toBe(900);
    expect(resource.fetchedAt).toBe(NOW);
    const fiveHour = resource.windows.find((w) => w.kind === "five-hour")!;
    expect(fiveHour.usedPercent).toBeCloseTo(32);
    expect(fiveHour.remainingPercent).toBeCloseTo(68);
    expect(fiveHour.resetsAt).toBe(1_800_000);
    const weekly = resource.windows.find((w) => w.kind === "weekly")!;
    // used/limit with a real denominator derives a true percentage.
    expect(weekly.usedPercent).toBeCloseTo(12);
    expect(weekly.remainingPercent).toBeCloseTo(88);
    // No resetsAt reported stays null.
    expect(weekly.resetsAt).toBeNull();
  });

  it("keeps unbounded amounts amount-only without inventing percentages", async () => {
    const { gateway } = fakeGateway({
      usage: {
        generatedAt: NOW,
        reports: [
          {
            provider: "openrouter",
            fetchedAt: 900,
            limits: [
              {
                id: "credits",
                label: "Credit balance",
                scope: { provider: "openrouter" },
                amount: { remaining: 7.32, unit: "usd" },
              },
            ],
          },
        ],
      },
      accounts: [
        ompAccount({
          id: "omp:openrouter:9",
          providerFamily: "openrouter",
          providerLabel: "OpenRouter",
          accountKey: null,
          email: null,
        }),
      ],
    });
    const source = new ArcOmpUsageSource({ gateway, now: () => NOW });
    const resource = await source.fetch("omp:openrouter:omp:openrouter:9", true);
    expect(resource.status).toBe("available");
    expect(resource.windows[0]!.usedPercent).toBeNull();
    expect(resource.windows[0]!.remainingPercent).toBeNull();
    expect(resource.windows[0]!.remainingAmount).toBe(7.32);
    expect(resource.windows[0]!.unit).toBe("usd");
  });

  it("maps unknown vendor windows to custom without losing the label", async () => {
    const { gateway } = fakeGateway({
      usage: {
        generatedAt: NOW,
        reports: [
          {
            provider: "kimi",
            fetchedAt: 900,
            limits: [
              {
                id: "rolling-3h",
                label: "Rolling 3 hours",
                scope: { provider: "kimi", accountId: "k1" },
                window: { id: "rolling-3h", label: "Rolling 3 hours", durationMs: 10_800_000 },
                amount: { usedFraction: 0.5, unit: "percent" },
              },
            ],
          },
        ],
      },
      accounts: [
        ompAccount({
          id: "omp:kimi:3",
          providerFamily: "kimi",
          providerLabel: "Kimi Code",
          accountKey: "omp:kimi:k1",
        }),
      ],
    });
    const source = new ArcOmpUsageSource({ gateway, now: () => NOW });
    const resource = await source.fetch("omp:kimi:omp:kimi:3", true);
    expect(resource.windows[0]!.kind).toBe("custom");
    expect(resource.windows[0]!.label).toBe("Rolling 3 hours");
  });

  it("reports accounts without usage as unavailable/not-exposed, never zero", async () => {
    const { gateway } = fakeGateway({
      usage: { generatedAt: NOW, reports: [] },
      accounts: [
        ompAccount({
          id: "omp:deepseek:4",
          providerFamily: "deepseek",
          providerLabel: "DeepSeek",
          accountKey: null,
          email: null,
        }),
      ],
    });
    const source = new ArcOmpUsageSource({ gateway, now: () => NOW });
    const resource = await source.fetch("omp:deepseek:omp:deepseek:4", true);
    expect(resource.status).toBe("unavailable");
    expect(resource.unavailableReason).toBe("not-exposed");
    expect(resource.windows).toEqual([]);
    expect(resource.agentIds).toEqual(["omp"]);
  });

  it("marks provider-disabled credentials distinctly from not-exposed", async () => {
    const { gateway } = fakeGateway({
      usage: { generatedAt: NOW, reports: [] },
      disabled: {
        generatedAt: NOW,
        disabled: [
          {
            id: 9,
            provider: "deepseek",
            cause: "401 from chat endpoint",
            disabledAtMs: NOW,
          },
        ],
      },
      accounts: [
        ompAccount({
          id: "omp:deepseek:4",
          providerFamily: "deepseek",
          providerLabel: "DeepSeek",
          accountKey: null,
          email: null,
        }),
      ],
    });
    const source = new ArcOmpUsageSource({ gateway, now: () => NOW });
    const resource = await source.fetch("omp:deepseek:omp:deepseek:4", true);
    expect(resource.status).toBe("unavailable");
    expect(resource.unavailableReason).toBe("disabled");
    expect(resource.credentialDisabled).toBe(true);
  });

  it("keeps the api-key account covered by a single-identity provider report", async () => {
    const { gateway } = fakeGateway({
      usage: {
        generatedAt: NOW,
        reports: [
          {
            provider: "deepseek",
            fetchedAt: 900,
            limits: [
              {
                id: "balance",
                label: "Balance",
                scope: { provider: "deepseek" },
                amount: { used: 1, limit: 10, unit: "credits" },
              },
            ],
          },
        ],
      },
      accounts: [
        ompAccount({
          id: "omp:deepseek:4",
          providerFamily: "deepseek",
          providerLabel: "DeepSeek",
          accountKey: null,
          email: null,
        }),
      ],
    });
    const source = new ArcOmpUsageSource({ gateway, now: () => NOW });
    const resource = await source.fetch("omp:deepseek:omp:deepseek:4", true);
    expect(resource.status).toBe("available");
    expect(resource.windows[0]!.unit).toBe("credits");
  });

  it("lists account resources as unknown usage without fetching the broker", async () => {
    let usageCalls = 0;
    const gateway: ArcOmpUsageGateway = {
      async fetchUsageSnapshot() {
        usageCalls += 1;
        return { usage: usageWire(), disabled: null };
      },
      async listOmpAccounts() {
        return [ompAccount()];
      },
    };
    const source = new ArcOmpUsageSource({ gateway, now: () => NOW });
    const resources = await source.list();
    expect(usageCalls).toBe(0);
    expect(resources[0]!.status).toBe("unknown");
    expect(resources[0]!.windows).toEqual([]);
  });

  it("throws usage-fetch-failed when the broker is unreachable", async () => {
    const { gateway } = fakeGateway({ failUsage: true });
    const source = new ArcOmpUsageSource({ gateway, now: () => NOW });
    await expect(
      source.fetch("omp:openai-codex:omp:openai-codex:7", true),
    ).rejects.toMatchObject({ code: "usage-fetch-failed" });
  });

  it("throws usage-contract-invalid on a malformed usage payload", async () => {
    const { gateway } = fakeGateway({ usage: { reports: "nope" } });
    const source = new ArcOmpUsageSource({ gateway, now: () => NOW });
    await expect(
      source.fetch("omp:openai-codex:omp:openai-codex:7", true),
    ).rejects.toMatchObject({ code: "usage-contract-invalid" });
  });

  it("throws usage-resource-not-found for an unknown resource id", async () => {
    const { gateway } = fakeGateway({});
    const source = new ArcOmpUsageSource({ gateway, now: () => NOW });
    await expect(source.fetch("omp:kimi:nope", true)).rejects.toMatchObject({
      code: "usage-resource-not-found",
    });
  });

  it("never leaks tokens or credential material in serialized resources", async () => {
    const { gateway } = fakeGateway({
      disabled: {
        generatedAt: NOW,
        disabled: [
          {
            id: 9,
            provider: "openai-codex",
            accountId: "chatgpt-acc-1",
            email: "adnan@example.com",
            cause: "refresh token rejected by provider",
            disabledAtMs: NOW,
          },
        ],
      },
    });
    const source = new ArcOmpUsageSource({ gateway, now: () => NOW });
    const resource = await source.fetch(
      "omp:openai-codex:omp:openai-codex:7",
      true,
    );
    const serialized = JSON.stringify(resource);
    for (const pattern of [
      /access[_-]?token/iu,
      /refresh[_-]?token/iu,
      /api[_-]?key/iu,
      /authorization/iu,
      /bearer/iu,
      /cookie/iu,
      /password/iu,
      /pkce/iu,
    ]) {
      expect(serialized).not.toMatch(pattern);
    }
  });
});
