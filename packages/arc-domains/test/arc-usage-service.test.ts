import { describe, expect, it } from "vitest";
import type { ArcAgentId } from "../src/arc-agent/types.js";
import { ArcThreadUsageSource } from "../src/arc-usage/thread-source.js";
import { ArcUsageService } from "../src/arc-usage/service.js";
import {
  ArcUsageError,
  type ArcCurrentAgentUsage,
  type ArcThreadContextGateway,
  type ArcUsageResource,
  type ArcUsageSource,
  type ArcUsageSourceKind,
  type ArcUsageWindowKind,
} from "../src/arc-usage/types.js";

// Service-level behavior: last-good stale data, source failure isolation,
// canonical-identity association rules, observational reads, and
// current-agent resolution.

const NOW = 10_000;

function window(
  overrides: Partial<ArcUsageResource["windows"][number]> = {},
): ArcUsageResource["windows"][number] {
  return {
    id: "five-hour",
    label: "Five-hour limit",
    kind: "five-hour" as ArcUsageWindowKind,
    status: null,
    usedPercent: 30,
    remainingPercent: 70,
    usedAmount: null,
    limitAmount: null,
    remainingAmount: null,
    unit: "percent",
    resetsAt: null,
    observedAt: 100,
    source: null,
    ...overrides,
  };
}

function resource(
  overrides: Partial<ArcUsageResource> = {},
): ArcUsageResource {
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
    windows: [window()],
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

class FakeSource implements ArcUsageSource {
  readonly kind: ArcUsageSourceKind;
  listed: ArcUsageResource[];
  fetchable: Map<string, ArcUsageResource | Error>;
  fetchCalls: { id: string; refresh: boolean }[] = [];

  constructor(
    kind: ArcUsageSourceKind,
    listed: ArcUsageResource[],
    fetchable: Map<string, ArcUsageResource | Error> = new Map(),
  ) {
    this.kind = kind;
    this.listed = listed;
    this.fetchable = fetchable;
  }

  async list(): Promise<ArcUsageResource[]> {
    return this.listed;
  }

  async fetch(id: string, refresh: boolean): Promise<ArcUsageResource> {
    this.fetchCalls.push({ id, refresh });
    const result = this.fetchable.get(id);
    if (result === undefined) {
      throw new ArcUsageError("usage-resource-not-found", `gone: ${id}`);
    }
    if (result instanceof Error) throw result;
    return result;
  }
}

function threadGateway(
  usage: {
    threadId: string;
    usedTokens: number;
    modelContextWindow: number;
    estimated: boolean;
    modelLabel: string | null;
  } | null,
): ArcThreadContextGateway {
  return {
    async getCurrentThreadContext() {
      return usage;
    },
  };
}

describe("ArcUsageService", () => {
  it("serves cached measurements from list without fetching providers", async () => {
    const pool = new FakeSource("pool", [resource()]);
    const service = new ArcUsageService({ sources: [pool], now: () => NOW });
    const snapshot = await service.listUsageResources();
    expect(snapshot.resources).toHaveLength(1);
    expect(pool.fetchCalls).toHaveLength(0);
  });

  it("keeps last-good data and marks it stale when a refresh fails", async () => {
    const good = resource();
    const pool = new FakeSource(
      "pool",
      [resource({ windows: [], status: "unknown" as const, observedAt: null, fetchedAt: null })],
      new Map([["pool:openai:a1", new Error("provider 500")]]),
    );
    const service = new ArcUsageService({ sources: [pool], now: () => NOW });
    await service.refreshUsageResource("pool:openai:a1");
    // First refresh failure with no prior data: error state, no zeros.
    pool.listed = [good];
    const first = await service.refreshUsageResource("pool:openai:a1");
    expect(first.status).toBe("available");
    pool.fetchable.set(
      "pool:openai:a1",
      new ArcUsageError("usage-fetch-failed", "provider 500"),
    );
    const second = await service.refreshUsageResource("pool:openai:a1");
    expect(second.status).toBe("available");
    expect(second.stale).toBe(true);
    expect(second.windows[0]!.usedPercent).toBe(30);
    expect(second.observedAt).toBe(100);
  });

  it("never fabricates zero usage for a provider that exposes none", async () => {
    const pool = new FakeSource("pool", [
      resource({
        windows: [],
        status: "unavailable",
        unavailableReason: "not-exposed",
        observedAt: null,
        message: null,
      }),
    ]);
    const service = new ArcUsageService({ sources: [pool], now: () => NOW });
    const snapshot = await service.listUsageResources();
    const listed = snapshot.resources[0]!;
    expect(listed.status).toBe("unavailable");
    expect(listed.unavailableReason).toBe("not-exposed");
    expect(listed.windows).toEqual([]);
  });

  it("isolates source failures: pool data survives an OMP outage", async () => {
    const pool = new FakeSource("pool", [resource()]);
    const omp = new FakeSource("omp", [], new Map());
    const failingOmp: ArcUsageSource = {
      kind: "omp",
      async list(): Promise<ArcUsageResource[]> {
        throw new Error("omp broker unreachable");
      },
      async fetch(): Promise<ArcUsageResource> {
        throw new Error("omp broker unreachable");
      },
    };
    const service = new ArcUsageService({
      sources: [pool, failingOmp],
      now: () => NOW,
    });
    const snapshot = await service.listUsageResources();
    expect(snapshot.resources.map((r) => r.id)).toContain("pool:openai:a1");
    const ompStatus = snapshot.sources.find((s) => s.kind === "omp")!;
    expect(ompStatus.state).toBe("unavailable");
    expect(ompStatus.detail).toContain("unreachable");
    const poolStatus = snapshot.sources.find((s) => s.kind === "pool")!;
    expect(poolStatus.state).toBe("ready");
    void omp;
  });

  it("isolates refresh failures per resource in refreshAllUsage", async () => {
    const good = resource();
    const failing = resource({
      id: "pool:openai:a2",
      accountKey: "openai:chatgpt:acc-2",
      accountSourceId: "a2",
    });
    // Source inventories are metadata-only; measurements come from fetch.
    const meta = (entry: ArcUsageResource): ArcUsageResource => ({
      ...entry,
      windows: [],
      status: "unknown",
      observedAt: null,
      fetchedAt: null,
    });
    const pool = new FakeSource(
      "pool",
      [meta(good), meta(failing)],
      new Map<string, ArcUsageResource | Error>([
        ["pool:openai:a1", good],
        ["pool:openai:a2", new Error("claude refresh exploded")],
      ]),
    );
    const service = new ArcUsageService({ sources: [pool], now: () => NOW });
    const snapshot = await service.refreshAllUsage();
    const okResource = snapshot.resources.find((r) => r.id === "pool:openai:a1")!;
    const failedResource = snapshot.resources.find(
      (r) => r.id === "pool:openai:a2",
    )!;
    expect(okResource.status).toBe("available");
    expect(okResource.stale).toBe(false);
    expect(failedResource.status).toBe("error");
    expect(failedResource.windows).toEqual([]);
    expect(snapshot.resources).toHaveLength(2);
  });

  it("associates identical canonical accountKeys with provenance, preferring newer observations", async () => {
    const poolVersion = resource({
      windows: [window({ usedPercent: 40, remainingPercent: 60, observedAt: 200 })],
      observedAt: 200,
      fetchedAt: 200,
    });
    const ompVersion = resource({
      id: "omp:openai-codex:omp:openai-codex:7",
      sourceKind: "omp",
      accountKey: "openai:chatgpt:acc-1",
      providerFamily: "openai-codex",
      agentIds: ["omp"],
      sources: ["omp"],
      windows: [window({ usedPercent: 24, remainingPercent: 76, observedAt: 900 })],
      observedAt: 900,
      fetchedAt: 900,
    });
    const service = new ArcUsageService({
      sources: [new FakeSource("pool", [poolVersion]), new FakeSource("omp", [ompVersion])],
      now: () => NOW,
    });
    const snapshot = await service.listUsageResources();
    expect(snapshot.resources).toHaveLength(1);
    const merged = snapshot.resources[0]!;
    expect(merged.sources).toEqual(["pool", "omp"]);
    expect(merged.agentIds).toEqual(["omp", "codex"]);
    expect(merged.windows[0]!.usedPercent).toBe(24);
    expect(merged.windows[0]!.source).toBe("omp");
    expect(merged.observedAt).toBe(900);
  });

  it("keeps same-email different-accountKey resources separate", async () => {
    const personal = resource();
    const work = resource({
      id: "pool:openai:a2",
      accountKey: "openai:chatgpt:acc-2",
      accountSourceId: "a2",
    });
    const service = new ArcUsageService({
      sources: [new FakeSource("pool", [personal, work])],
      now: () => NOW,
    });
    const snapshot = await service.listUsageResources();
    expect(snapshot.resources).toHaveLength(2);
  });

  it("never cross-source merges null-accountKey resources", async () => {
    const poolLocal = resource({ accountKey: null, id: "pool:openai:a1" });
    const ompLocal = resource({
      accountKey: null,
      id: "omp:openai-codex:omp:openai-codex:7",
      sourceKind: "omp",
      agentIds: ["omp"],
      sources: ["omp"],
    });
    const service = new ArcUsageService({
      sources: [
        new FakeSource("pool", [poolLocal]),
        new FakeSource("omp", [ompLocal]),
      ],
      now: () => NOW,
    });
    const snapshot = await service.listUsageResources();
    expect(snapshot.resources).toHaveLength(2);
  });

  it("maps agent association: OMP usage never attaches to Codex", async () => {
    const ompResource = resource({
      id: "omp:kimi:omp:kimi:3",
      sourceKind: "omp",
      accountKey: "omp:kimi:k1",
      providerFamily: "kimi",
      agentIds: ["omp"],
      sources: ["omp"],
    });
    const service = new ArcUsageService({
      sources: [new FakeSource("omp", [ompResource])],
      now: () => NOW,
    });
    const codexUsage: ArcCurrentAgentUsage = await service.getCurrentAgentUsage({
      agentId: "codex",
    });
    expect(codexUsage.resources).toHaveLength(0);
    const ompUsage = await service.getCurrentAgentUsage({ agentId: "omp" });
    expect(ompUsage.resources.map((r) => r.id)).toEqual(["omp:kimi:omp:kimi:3"]);
  });

  it("resolves the current thread context as its own resource, separate from quota", async () => {
    const thread = new ArcThreadUsageSource({
      gateway: threadGateway({
        threadId: "thr-1",
        usedTokens: 195_000,
        modelContextWindow: 1_000_000,
        estimated: false,
        modelLabel: "K2.8",
      }),
      now: () => NOW,
    });
    const service = new ArcUsageService({
      sources: [new FakeSource("pool", [resource()]), thread],
      now: () => NOW,
    });
    const usage = await service.getCurrentAgentUsage({ agentId: "codex" });
    expect(usage.thread).not.toBeNull();
    expect(usage.thread!.sourceKind).toBe("thread");
    expect(usage.thread!.windows[0]!.usedAmount).toBe(195_000);
    expect(usage.thread!.windows[0]!.usedPercent).toBeCloseTo(19.5);
    expect(usage.resources.every((r) => r.sourceKind !== "thread")).toBe(true);
    expect(usage.resources).toHaveLength(1);
  });

  it("reports activeAccountUnknown when no active account identity is supplied", async () => {
    const service = new ArcUsageService({
      sources: [new FakeSource("pool", [resource()])],
      now: () => NOW,
    });
    const usage = await service.getCurrentAgentUsage({ agentId: "codex" });
    expect(usage.activeAccountUnknown).toBe(true);
    expect(usage.resources).toHaveLength(1);
    const focused = await service.getCurrentAgentUsage({
      agentId: "codex",
      activeAccountKey: "openai:chatgpt:other",
    });
    // Resources whose account is provably different drop out; unknown ones stay.
    expect(focused.activeAccountUnknown).toBe(false);
    expect(focused.resources).toHaveLength(0);
  });

  it("treats thread context as unavailable rather than inventing numbers when no thread exists", async () => {
    const thread = new ArcThreadUsageSource({
      gateway: threadGateway(null),
      now: () => NOW,
    });
    const service = new ArcUsageService({
      sources: [thread],
      now: () => NOW,
    });
    const snapshot = await service.listUsageResources();
    expect(snapshot.resources).toEqual([]);
    const usage = await service.getCurrentAgentUsage({ agentId: "omp" });
    expect(usage.thread).toBeNull();
  });
});
