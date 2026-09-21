import { describe, expect, it } from "vitest";
import type { ArcAgentId } from "../src/arc-agent/types.js";
import {
  ompProviderFromModelId,
  resolveArcActiveUsageAccount,
} from "../src/arc-usage/active-account.js";
import { ArcUsageService } from "../src/arc-usage/service.js";
import type {
  ArcUsageResource,
  ArcUsageSource,
  ArcUsageSourceKind,
} from "../src/arc-usage/types.js";

// Active-account resolution for a thread's Usage & Limits surface. The
// load-bearing rules: a thread's own binding is exact, an OMP thread may be
// answered by the provider its selected model belongs to, and everything else
// stays unknown instead of showing an account the user did not choose.

const NOW = 10_000;

function resource(overrides: Partial<ArcUsageResource> = {}): ArcUsageResource {
  return {
    id: "pool:openai:a1",
    sourceKind: "pool" as ArcUsageSourceKind,
    accountKey: "openai:chatgpt:acc-1",
    accountSourceId: "a1",
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountEmail: "a@b.c",
    planLabel: null,
    modelLabel: null,
    agentIds: ["codex" as ArcAgentId],
    windows: [],
    observedAt: 100,
    fetchedAt: 100,
    stale: false,
    status: "available",
    unavailableReason: null,
    credentialDisabled: false,
    message: null,
    sources: ["pool" as ArcUsageSourceKind],
    ...overrides,
  };
}

function ompAccount(
  provider: string,
  overrides: Partial<ArcUsageResource> = {},
): ArcUsageResource {
  return resource({
    id: `omp:${provider}:omp:${provider}:1`,
    sourceKind: "omp",
    accountKey: `omp:${provider}:credential-1`,
    accountSourceId: `omp:${provider}:1`,
    providerFamily: provider,
    providerLabel: provider === "kimi-code" ? "Kimi Code" : "OpenCode Go",
    accountEmail: null,
    agentIds: ["omp"],
    sources: ["omp"],
    ...overrides,
  });
}

class FakeSource implements ArcUsageSource {
  readonly kind: ArcUsageSourceKind = "omp";
  constructor(private readonly listed: ArcUsageResource[]) {}

  async list(): Promise<ArcUsageResource[]> {
    return this.listed;
  }

  async fetch(id: string): Promise<ArcUsageResource> {
    const found = this.listed.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`missing ${id}`);
    return found;
  }
}

function serviceFor(resources: ArcUsageResource[]): ArcUsageService {
  return new ArcUsageService({
    sources: [new FakeSource(resources)],
    now: () => NOW,
  });
}

describe("ompProviderFromModelId", () => {
  it("reads the provider segment OMP namespaces every model id with", () => {
    expect(ompProviderFromModelId("kimi-code/kimi-for-coding")).toBe(
      "kimi-code",
    );
    expect(ompProviderFromModelId("opencode-go/deepseek-v4.1-flash")).toBe(
      "opencode-go",
    );
  });

  it("names no provider when the id carries no usable namespace", () => {
    expect(ompProviderFromModelId("default")).toBeNull();
    expect(ompProviderFromModelId("/kimi-k2")).toBeNull();
    expect(ompProviderFromModelId("kimi-code/")).toBeNull();
    expect(ompProviderFromModelId("")).toBeNull();
    expect(ompProviderFromModelId(null)).toBeNull();
    expect(ompProviderFromModelId(undefined)).toBeNull();
  });
});

describe("resolveArcActiveUsageAccount", () => {
  const kimi = ompAccount("kimi-code");
  const openCode = ompAccount("opencode-go", {
    accountKey: null,
    accountSourceId: "omp:opencode-go:1",
  });

  it("answers an unpinned OMP thread from the provider its model belongs to", () => {
    const resolution = resolveArcActiveUsageAccount({
      agentId: "omp",
      activeModelId: "kimi-code/kimi-for-coding",
      resources: [kimi, openCode],
    });
    expect(resolution.activeAccountUnknown).toBe(false);
    expect(resolution.activeAccount).toMatchObject({
      providerLabel: "Kimi Code",
      accountKey: "omp:kimi-code:credential-1",
      resolvedBy: "provider",
    });
    expect(resolution.resources.map((entry) => entry.id)).toEqual([kimi.id]);
  });

  it("resolves an OMP api-key account that has no provider-issued identity", () => {
    const resolution = resolveArcActiveUsageAccount({
      agentId: "omp",
      activeModelId: "opencode-go/ox-alpha-free",
      resources: [kimi, openCode],
    });
    expect(resolution.activeAccountUnknown).toBe(false);
    expect(resolution.activeAccount).toMatchObject({
      providerLabel: "OpenCode Go",
      accountKey: null,
      accountSourceId: "omp:opencode-go:1",
      resolvedBy: "provider",
    });
    expect(resolution.resources.map((entry) => entry.id)).toEqual([
      openCode.id,
    ]);
  });

  it("keeps the thread's own binding exact, even when the model disagrees", () => {
    const resolution = resolveArcActiveUsageAccount({
      agentId: "omp",
      activeAccountKey: "omp:opencode-go:1",
      activeModelId: "kimi-code/kimi-for-coding",
      resources: [kimi, openCode],
    });
    expect(resolution.activeAccountUnknown).toBe(false);
    expect(resolution.activeAccount).toMatchObject({
      accountSourceId: "omp:opencode-go:1",
      resolvedBy: "binding",
    });
    expect(resolution.resources.map((entry) => entry.id)).toEqual([
      openCode.id,
    ]);
  });

  it("matches a binding by canonical key as well as by account id", () => {
    const byCanonicalKey = resolveArcActiveUsageAccount({
      agentId: "omp",
      activeAccountKey: "omp:kimi-code:credential-1",
      resources: [kimi, openCode],
    });
    expect(byCanonicalKey.resources.map((entry) => entry.id)).toEqual([kimi.id]);
  });

  it("never picks one of several connected accounts of the same provider", () => {
    const second = ompAccount("kimi-code", {
      id: "omp:kimi-code:omp:kimi-code:2",
      accountKey: "omp:kimi-code:credential-2",
      accountSourceId: "omp:kimi-code:2",
    });
    const resolution = resolveArcActiveUsageAccount({
      agentId: "omp",
      activeModelId: "kimi-code/kimi-for-coding",
      resources: [kimi, second],
    });
    expect(resolution.activeAccount).toBeNull();
    expect(resolution.activeAccountUnknown).toBe(true);
    // The caller may offer the choice; it may not present one as the thread's.
    expect(resolution.resources).toHaveLength(2);
  });

  it("stays unknown when the model's provider has no connected account", () => {
    const resolution = resolveArcActiveUsageAccount({
      agentId: "omp",
      activeModelId: "kimi-code/kimi-for-coding",
      resources: [openCode],
    });
    expect(resolution.activeAccount).toBeNull();
    expect(resolution.activeAccountUnknown).toBe(true);
  });

  it("stays unknown for a non-OMP agent with no binding", () => {
    const plus = resource();
    const team = resource({
      id: "pool:openai:a2",
      accountKey: "openai:chatgpt:acc-2",
      accountSourceId: "a2",
    });
    const resolution = resolveArcActiveUsageAccount({
      agentId: "codex",
      activeModelId: "openai/gpt-5.6-sol",
      resources: [plus, team],
    });
    expect(resolution.activeAccount).toBeNull();
    expect(resolution.activeAccountUnknown).toBe(true);
    expect(resolution.resources).toHaveLength(2);
  });

  it("excludes the other Codex account when the thread is bound to one", () => {
    const plus = resource();
    const team = resource({
      id: "pool:openai:a2",
      accountKey: "openai:chatgpt:acc-2",
      accountSourceId: "a2",
    });
    const resolution = resolveArcActiveUsageAccount({
      agentId: "codex",
      activeAccountKey: "openai:chatgpt:acc-2",
      resources: [plus, team],
    });
    expect(resolution.activeAccount).toMatchObject({
      accountKey: "openai:chatgpt:acc-2",
      resolvedBy: "binding",
    });
    expect(resolution.resources.map((entry) => entry.id)).toEqual([team.id]);
  });
});

describe("ArcUsageService active-account resolution", () => {
  it("answers an unpinned OMP thread without inventing a binding", async () => {
    const kimi = ompAccount("kimi-code");
    const openCode = ompAccount("opencode-go", { accountKey: null });
    const service = serviceFor([kimi, openCode]);

    const unknown = await service.getCurrentAgentUsage({ agentId: "omp" });
    expect(unknown.activeAccountUnknown).toBe(true);
    expect(unknown.activeAccount).toBeNull();
    expect(unknown.resources).toHaveLength(2);

    const resolved = await service.getCurrentAgentUsage({
      agentId: "omp",
      activeModelId: "kimi-code/kimi-for-coding",
    });
    expect(resolved.activeAccountUnknown).toBe(false);
    expect(resolved.activeAccount?.providerLabel).toBe("Kimi Code");
    expect(resolved.resources.map((entry) => entry.id)).toEqual([kimi.id]);
  });

  it("keeps the thread context resource out of the account's quota resources", async () => {
    const kimi = ompAccount("kimi-code");
    const thread = resource({
      id: "thread:thr-1",
      sourceKind: "thread",
      accountKey: null,
      accountSourceId: null,
      providerFamily: null,
      providerLabel: "Context window",
      accountEmail: null,
      agentIds: ["omp"],
      sources: ["thread"],
    });
    const service = serviceFor([kimi, thread]);
    const usage = await service.getCurrentAgentUsage({
      agentId: "omp",
      activeModelId: "kimi-code/kimi-for-coding",
    });
    expect(usage.thread?.id).toBe("thread:thr-1");
    expect(usage.resources.map((entry) => entry.id)).toEqual([kimi.id]);
  });
});
