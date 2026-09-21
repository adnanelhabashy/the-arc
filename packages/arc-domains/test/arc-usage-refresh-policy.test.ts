import { describe, expect, it } from "vitest";
import { ArcUsageService } from "../src/arc-usage/service.js";
import {
  ArcUsageError,
  type ArcUsageResource,
  type ArcUsageSource,
  type ArcUsageSourceKind,
} from "../src/arc-usage/types.js";

// Phase 14 refresh/cache policy for Usage & Limits. The pool and OMP list
// resources WITHOUT a measurement (status "unknown", no windows); the numbers
// live behind a separate fetch. These tests pin the resulting rules:
//
// - a cheap read overlays the last known measurement and never drops it;
// - UNKNOWN != ZERO survives every path;
// - a measurement belongs to exactly one account;
// - a measurement Arc knows is gone is evicted, and a source outage never
//   evicts another source's data;
// - concurrent reads share one source listing;
// - a background fill is non-forcing, staleness-gated and single-flight;
// - a late answer for account A never lands on account B.

const NOW = 10_000;

function window(
  overrides: Partial<ArcUsageResource["windows"][number]> = {},
): ArcUsageResource["windows"][number] {
  return {
    id: "five-hour",
    label: "Five-hour limit",
    kind: "five-hour",
    status: null,
    usedPercent: 30,
    remainingPercent: 70,
    usedAmount: null,
    limitAmount: null,
    remainingAmount: null,
    unit: "percent",
    resetsAt: null,
    observedAt: NOW - 1_000,
    source: null,
    ...overrides,
  };
}

function resource(overrides: Partial<ArcUsageResource> = {}): ArcUsageResource {
  return {
    id: "pool:openai:a1",
    sourceKind: "pool",
    accountKey: "openai:chatgpt:acc-1",
    accountSourceId: "a1",
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountEmail: "a@b.c",
    planLabel: "Plus",
    modelLabel: null,
    agentIds: ["codex"],
    windows: [window()],
    observedAt: NOW - 1_000,
    fetchedAt: NOW - 1_000,
    stale: false,
    status: "available",
    unavailableReason: null,
    credentialDisabled: false,
    message: null,
    sources: ["pool"],
    ...overrides,
  };
}

// What a real source returns from list(): identity only, no measurement.
function listed(overrides: Partial<ArcUsageResource> = {}): ArcUsageResource {
  return resource({
    windows: [],
    observedAt: null,
    fetchedAt: null,
    status: "unknown",
    planLabel: null,
    accountEmail: null,
    ...overrides,
  });
}

interface FetchCall {
  id: string;
  refresh: boolean;
}

class FakeSource implements ArcUsageSource {
  readonly kind: ArcUsageSourceKind;
  listed: ArcUsageResource[];
  fetchable: Map<string, ArcUsageResource | Error>;
  readonly fetchCalls: FetchCall[] = [];
  listCalls = 0;

  constructor(
    kind: ArcUsageSourceKind,
    listedResources: ArcUsageResource[],
    fetchable: Map<string, ArcUsageResource | Error> = new Map(),
  ) {
    this.kind = kind;
    this.listed = listedResources;
    this.fetchable = fetchable;
  }

  async list(): Promise<ArcUsageResource[]> {
    this.listCalls += 1;
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

function makeService(
  sources: ArcUsageSource[],
  options: { now?: () => number; onMeasurementsChanged?: () => void } = {},
): ArcUsageService {
  return new ArcUsageService({
    sources,
    now: options.now ?? (() => NOW),
    onMeasurementsChanged: options.onMeasurementsChanged,
  });
}

describe("ArcUsageService read policy", () => {
  it("serves the last known measurement from a metadata-only inventory read", async () => {
    const source = new FakeSource(
      "pool",
      [listed()],
      new Map([["pool:openai:a1", resource()]]),
    );
    const service = makeService([source]);
    await service.refreshUsageResource("pool:openai:a1");

    const snapshot = await service.listUsageResources();
    const served = snapshot.resources[0]!;
    expect(served.status).toBe("available");
    expect(served.windows).toHaveLength(1);
    expect(served.windows[0]!.usedPercent).toBe(30);
    expect(served.planLabel).toBe("Plus");
  });

  it("keeps UNKNOWN != ZERO when no measurement has ever been obtained", async () => {
    const source = new FakeSource("pool", [listed()]);
    const service = makeService([source]);
    const snapshot = await service.listUsageResources();
    expect(snapshot.resources[0]!.status).toBe("unknown");
    expect(snapshot.resources[0]!.windows).toEqual([]);
  });

  it("never serves one account's measurement for another account", async () => {
    const plus = listed({ id: "pool:openai:a1", accountKey: "openai:chatgpt:plus" });
    const team = listed({
      id: "pool:openai:a2",
      accountSourceId: "a2",
      accountKey: "openai:chatgpt:team",
    });
    const source = new FakeSource(
      "pool",
      [plus, team],
      new Map([
        [
          "pool:openai:a1",
          resource({
            id: "pool:openai:a1",
            accountKey: "openai:chatgpt:plus",
            windows: [window({ usedPercent: 8 })],
          }),
        ],
        [
          "pool:openai:a2",
          resource({
            id: "pool:openai:a2",
            accountKey: "openai:chatgpt:team",
            windows: [window({ usedPercent: 64 })],
          }),
        ],
      ]),
    );
    const service = makeService([source]);
    await service.refreshAllUsage();

    const plusUsage = await service.getCurrentAgentUsage({
      agentId: "codex",
      activeAccountKey: "openai:chatgpt:plus",
    });
    expect(plusUsage.resources.map((entry) => entry.id)).toEqual([
      "pool:openai:a1",
    ]);
    expect(plusUsage.resources[0]!.windows[0]!.usedPercent).toBe(8);

    const teamUsage = await service.getCurrentAgentUsage({
      agentId: "codex",
      activeAccountKey: "openai:chatgpt:team",
    });
    expect(teamUsage.resources[0]!.windows[0]!.usedPercent).toBe(64);
  });

  it("takes identity from the listing and the measurement from the cache", async () => {
    const source = new FakeSource(
      "pool",
      [listed()],
      new Map([["pool:openai:a1", resource()]]),
    );
    const service = makeService([source]);
    await service.refreshUsageResource("pool:openai:a1");

    // The pool re-resolves the same row to a different credential.
    source.listed = [
      listed({
        accountKey: "openai:chatgpt:rotated",
        accountSourceId: "a1-rotated",
      }),
    ];
    const served = (await service.listUsageResources()).resources[0]!;
    expect(served.accountKey).toBe("openai:chatgpt:rotated");
    expect(served.accountSourceId).toBe("a1-rotated");
    expect(served.windows[0]!.usedPercent).toBe(30);
  });

  it("drops a cached measurement when the account behind it disappears", async () => {
    const source = new FakeSource(
      "pool",
      [listed()],
      new Map([["pool:openai:a1", resource()]]),
    );
    const service = makeService([source]);
    await service.refreshUsageResource("pool:openai:a1");
    expect((await service.listUsageResources()).resources).toHaveLength(1);

    source.listed = [];
    expect((await service.listUsageResources()).resources).toEqual([]);

    // Re-listing the same id later must not resurrect the removed reading.
    source.listed = [listed()];
    const served = (await service.listUsageResources()).resources[0]!;
    expect(served.status).toBe("unknown");
    expect(served.windows).toEqual([]);
  });

  it("never lets a failing source evict another source's measurement", async () => {
    const pool = new FakeSource(
      "pool",
      [listed()],
      new Map([["pool:openai:a1", resource()]]),
    );
    const omp = new FakeSource("omp", [
      listed({
        id: "omp:kimi:c1",
        sourceKind: "omp",
        accountKey: "omp:kimi:acc-9",
      }),
    ]);
    let ompDown = false;
    const flakyOmp: ArcUsageSource = {
      kind: "omp",
      async list() {
        if (ompDown) throw new Error("broker unreachable");
        return omp.list();
      },
      fetch: (id, refresh) => omp.fetch(id, refresh),
    };
    const service = makeService([pool, flakyOmp]);
    await service.refreshUsageResource("pool:openai:a1");

    ompDown = true;
    const snapshot = await service.listUsageResources();
    const served = snapshot.resources.find((entry) => entry.id === "pool:openai:a1")!;
    expect(served.windows).toHaveLength(1);
    expect(
      snapshot.sources.find((status) => status.kind === "omp")!.state,
    ).toBe("unavailable");
  });

  it("drops cached measurements Arc knows were invalidated", async () => {
    const source = new FakeSource(
      "pool",
      [listed()],
      new Map([["pool:openai:a1", resource()]]),
    );
    const service = makeService([source]);
    await service.refreshUsageResource("pool:openai:a1");

    service.invalidateUsage({ agentId: "codex" });
    const served = (await service.listUsageResources()).resources[0]!;
    expect(served.status).toBe("unknown");
    expect(served.windows).toEqual([]);
  });

  it("leaves other accounts' measurements alone when one account is invalidated", async () => {
    const source = new FakeSource(
      "pool",
      [
        listed({ id: "pool:openai:a1", accountKey: "openai:chatgpt:plus" }),
        listed({
          id: "pool:openai:a2",
          accountSourceId: "a2",
          accountKey: "openai:chatgpt:team",
        }),
      ],
      new Map([
        ["pool:openai:a1", resource({ accountKey: "openai:chatgpt:plus" })],
        [
          "pool:openai:a2",
          resource({
            id: "pool:openai:a2",
            accountKey: "openai:chatgpt:team",
            windows: [window({ usedPercent: 64 })],
          }),
        ],
      ]),
    );
    const service = makeService([source]);
    await service.refreshAllUsage();

    service.invalidateUsage({ accountKey: "openai:chatgpt:plus" });
    const snapshot = await service.listUsageResources();
    const team = snapshot.resources.find((entry) => entry.id === "pool:openai:a2")!;
    expect(team.windows[0]!.usedPercent).toBe(64);
  });

  it("coalesces concurrent inventory reads into one source listing", async () => {
    const source = new FakeSource("pool", [listed()]);
    const service = makeService([source]);
    await Promise.all([
      service.listUsageResources(),
      service.listUsageResources(),
      service.getCurrentAgentUsage({ agentId: "codex" }),
    ]);
    expect(source.listCalls).toBe(1);
  });

  it("backs a whole refreshAll with a single inventory", async () => {
    const source = new FakeSource(
      "pool",
      [
        listed({ id: "pool:openai:a1", accountKey: "openai:chatgpt:acc-1" }),
        listed({
          id: "pool:openai:a2",
          accountSourceId: "a2",
          accountKey: "openai:chatgpt:acc-2",
        }),
        listed({
          id: "pool:openai:a3",
          accountSourceId: "a3",
          accountKey: "openai:chatgpt:acc-3",
        }),
      ],
      new Map([
        ["pool:openai:a1", resource({ accountKey: "openai:chatgpt:acc-1" })],
        [
          "pool:openai:a2",
          resource({
            id: "pool:openai:a2",
            accountSourceId: "a2",
            accountKey: "openai:chatgpt:acc-2",
          }),
        ],
        [
          "pool:openai:a3",
          resource({
            id: "pool:openai:a3",
            accountSourceId: "a3",
            accountKey: "openai:chatgpt:acc-3",
          }),
        ],
      ]),
    );
    const service = makeService([source]);
    await service.refreshAllUsage();
    // One inventory plus one measurement per resource — not one inventory per
    // resource on top of the first.
    expect(source.listCalls).toBe(1);
    expect(source.fetchCalls).toHaveLength(3);
    expect(source.fetchCalls.every((call) => call.refresh)).toBe(true);
  });
});

describe("ArcUsageService background measurement fill", () => {
  it("fills a missing measurement without forcing the source", async () => {
    const source = new FakeSource(
      "pool",
      [listed()],
      new Map([["pool:openai:a1", resource()]]),
    );
    // Executor form: this package's tsconfig lib predates
    // Promise.withResolvers (see arc-runtime/claude-manifest-mutation tests).
    let measured: () => void = () => undefined;
    const measuredOnce = new Promise<void>((resolve) => {
      measured = resolve;
    });
    let changed = 0;
    const service = makeService([source], {
      onMeasurementsChanged: () => {
        changed += 1;
        measured();
      },
    });

    await service.listUsageResources();
    // The fill is scheduled synchronously with the read, so the fetch call is
    // already visible; the promise awaits the fill's own completion signal
    // rather than a guessed delay.
    expect(source.fetchCalls).toEqual([{ id: "pool:openai:a1", refresh: false }]);
    await measuredOnce;
    expect(changed).toBe(1);
    const served = (await service.listUsageResources()).resources[0]!;
    expect(served.windows).toHaveLength(1);
  });

  it("does not re-fill a measurement that is still fresh", async () => {
    const source = new FakeSource(
      "pool",
      [listed()],
      new Map([["pool:openai:a1", resource()]]),
    );
    const service = makeService([source]);
    await service.refreshUsageResource("pool:openai:a1");
    source.fetchCalls.length = 0;

    await service.listUsageResources();
    expect(source.fetchCalls).toEqual([]);
  });

  it("re-fills once the measurement is past its bound", async () => {
    let now = NOW;
    const source = new FakeSource(
      "pool",
      [listed()],
      new Map([["pool:openai:a1", resource()]]),
    );
    const service = makeService([source], { now: () => now });
    await service.refreshUsageResource("pool:openai:a1");
    source.fetchCalls.length = 0;

    now = NOW + 5 * 60 * 1_000;
    await service.listUsageResources();
    expect(source.fetchCalls).toEqual([{ id: "pool:openai:a1", refresh: false }]);
  });

  it("retries an errored measurement sooner than a good one", async () => {
    let now = NOW;
    const source = new FakeSource(
      "pool",
      [listed()],
      new Map([["pool:openai:a1", new Error("provider 500")]]),
    );
    const service = makeService([source], { now: () => now });
    await service.refreshUsageResource("pool:openai:a1");
    expect((await service.listUsageResources()).resources[0]!.status).toBe("error");
    source.fetchCalls.length = 0;

    now = NOW + 60 * 1_000;
    await service.listUsageResources();
    expect(source.fetchCalls).toEqual([{ id: "pool:openai:a1", refresh: false }]);
  });

  it("never re-fills a provider that does not expose usage at all", async () => {
    const source = new FakeSource(
      "pool",
      [listed()],
      new Map([
        [
          "pool:openai:a1",
          resource({
            windows: [],
            status: "unavailable",
            unavailableReason: "not-exposed",
            message: "Usage limits not exposed by provider",
          }),
        ],
      ]),
    );
    const service = makeService([source]);
    await service.refreshUsageResource("pool:openai:a1");
    source.fetchCalls.length = 0;

    await service.listUsageResources();
    expect(source.fetchCalls).toEqual([]);
  });

  it("shares one fill across concurrent reads", async () => {
    const source = new FakeSource(
      "pool",
      [listed()],
      new Map([["pool:openai:a1", resource()]]),
    );
    const service = makeService([source]);
    await Promise.all([
      service.listUsageResources(),
      service.listUsageResources(),
      service.listUsageResources(),
    ]);
    expect(source.fetchCalls).toHaveLength(1);
  });

  it("recovers from a cached error state on the next measurement", async () => {
    const fetchable = new Map<string, ArcUsageResource | Error>([
      ["pool:openai:a1", new Error("provider 500")],
    ]);
    const source = new FakeSource("pool", [listed()], fetchable);
    const service = makeService([source]);
    const failed = await service.refreshUsageResource("pool:openai:a1");
    expect(failed.status).toBe("error");
    expect(failed.windows).toEqual([]);

    fetchable.set("pool:openai:a1", resource());
    const recovered = await service.refreshUsageResource("pool:openai:a1");
    expect(recovered.status).toBe("available");
    expect(recovered.windows[0]!.usedPercent).toBe(30);
    const served = (await service.listUsageResources()).resources[0]!;
    expect(served.status).toBe("available");
  });
});

describe("ArcUsageService account-switch race", () => {
  it("never lets a late measurement for one account land on another", async () => {
    const plusId = "pool:openai:a1";
    const teamId = "pool:openai:a2";
    // Executor form: this package's tsconfig lib predates
    // Promise.withResolvers.
    let releasePlus: () => void = () => undefined;
    const plusGate = new Promise<void>((resolve) => {
      releasePlus = resolve;
    });
    const source = new FakeSource(
      "pool",
      [
        listed({ id: plusId, accountKey: "openai:chatgpt:plus" }),
        listed({
          id: teamId,
          accountSourceId: "a2",
          accountKey: "openai:chatgpt:team",
        }),
      ],
      new Map([
        [
          plusId,
          resource({ accountKey: "openai:chatgpt:plus", windows: [window({ usedPercent: 8 })] }),
        ],
        [
          teamId,
          resource({
            id: teamId,
            accountKey: "openai:chatgpt:team",
            windows: [window({ usedPercent: 64 })],
          }),
        ],
      ]),
    );
    const service = makeService([source]);
    const originalFetch = source.fetch.bind(source);
    source.fetch = async (id, refresh) => {
      // Account A's request starts first and answers last.
      if (id === plusId) await plusGate;
      return originalFetch(id, refresh);
    };

    const plusRefresh = service.refreshUsageResource(plusId);
    const teamRefresh = service.refreshUsageResource(teamId);
    releasePlus();
    await Promise.all([plusRefresh, teamRefresh]);

    const teamUsage = await service.getCurrentAgentUsage({
      agentId: "codex",
      activeAccountKey: "openai:chatgpt:team",
    });
    expect(teamUsage.resources.map((entry) => entry.id)).toEqual([teamId]);
    expect(teamUsage.resources[0]!.windows[0]!.usedPercent).toBe(64);
  });
});
