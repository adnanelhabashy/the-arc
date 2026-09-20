import { describe, expect, it } from "vitest";
import { ArcAccountService } from "../src/arc-account/service.js";
import {
  ArcAccountError,
  type ArcAccount,
  type ArcAccountSource,
  type ArcOmpLoginChallenge,
  type ArcOmpLoginPoll,
  type ArcOmpProvider,
} from "../src/arc-account/types.js";

// Fake sources exercising ArcAccountService's multi-source aggregation:
// pool + OMP records coexist, identical emails never merge, and one source
// failing degrades only its own accounts.
function account(overrides: Partial<ArcAccount>): ArcAccount {
  return {
    id: "pool:x",
    sourceId: "x",
    sourceKind: "pool",
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountKey: null,
    email: null,
    planLabel: null,
    authState: "connected",
    enabled: true,
    availableThrough: ["codex"],
    observedAt: 1,
    ...overrides,
  };
}

class FakeSource implements ArcAccountSource {
  readonly kind: "pool" | "omp";
  accounts: ArcAccount[];
  fail: Error | null = null;

  constructor(kind: "pool" | "omp", accounts: ArcAccount[]) {
    this.kind = kind;
    this.accounts = accounts;
  }

  async listAccounts(): Promise<ArcAccount[]> {
    if (this.fail !== null) throw this.fail;
    return this.accounts;
  }

  async getAccount(sourceId: string): Promise<ArcAccount> {
    const found = this.accounts.find((entry) => entry.sourceId === sourceId);
    if (found === undefined) throw new ArcAccountError("account-not-found", sourceId);
    return found;
  }

  async setAccountEnabled(_sourceId: string, _enabled: boolean): Promise<ArcAccount> {
    throw new Error("not used");
  }

  async removeAccount(_sourceId: string): Promise<void> {
    throw new Error("not used");
  }

  async setAccountPriority(_sourceId: string, _priority: number): Promise<ArcAccount> {
    throw new Error("not used");
  }

  async reorderAccounts(
    _providerFamily: string,
    _orderedSourceIds: string[],
  ): Promise<void> {
    throw new Error("not used");
  }

  async startOpenAiLogin(): Promise<never> {
    throw new Error("not used");
  }

  async pollOpenAiLogin(): Promise<never> {
    throw new Error("not used");
  }

  async cancelOpenAiLogin(): Promise<void> {
    throw new Error("not used");
  }

  async startClaudeLogin(): Promise<never> {
    throw new Error("not used");
  }

  async completeClaudeLogin(): Promise<never> {
    throw new Error("not used");
  }
}

class FakeOmpSource extends FakeSource {
  loginStarts = 0;
  loginError: Error | null = null;
  pollResult: ArcOmpLoginPoll = { state: "waiting-for-user", account: null, message: null };

  constructor(accounts: ArcAccount[]) {
    super("omp", accounts);
  }

  async listOmpProviders(): Promise<ArcOmpProvider[]> {
    return [];
  }

  async startOmpLogin(provider: string): Promise<ArcOmpLoginChallenge> {
    this.loginStarts += 1;
    if (this.loginError !== null) throw this.loginError;
    return {
      provider,
      sessionId: `session-${provider}`,
      kind: "oauth",
      flow: "browser",
      userCode: null,
      authorizeUrl: "https://provider.example.com/authorize",
      instructions: null,
      expiresAt: null,
    };
  }

  async pollOmpLogin(): Promise<ArcOmpLoginPoll> {
    return this.pollResult;
  }

  async cancelOmpLogin(): Promise<void> {
    return;
  }

  submitOmpLoginKey(): void {
    throw new Error("not used");
  }
}

const poolCodex = account({
  id: "pool:chatgpt-1",
  sourceId: "chatgpt-1",
  providerFamily: "openai",
  providerLabel: "ChatGPT",
  accountKey: "openai:chatgpt:42",
  email: "adnan@example.com",
  availableThrough: ["codex"],
});

const poolClaude = account({
  id: "pool:claude-1",
  sourceId: "claude-1",
  providerFamily: "anthropic",
  providerLabel: "Claude",
  accountKey: "anthropic:account:uuid-1",
  email: "adnan@example.com",
  availableThrough: ["claude-code"],
});

const ompKimi = account({
  id: "omp:kimi-code:7",
  sourceId: "kimi-code:7",
  sourceKind: "omp",
  providerFamily: "kimi-code",
  providerLabel: "Kimi Code",
  accountKey: "omp:kimi-code:k1",
  email: "kimi@example.com",
  availableThrough: ["omp"],
});

describe("ArcAccountService multi-source merging", () => {
  it("returns pool and OMP accounts together without dedup", async () => {
    const service = new ArcAccountService({
      sources: [
        new FakeSource("pool", [poolCodex, poolClaude]),
        new FakeOmpSource([ompKimi]),
      ],
    });
    const accounts = await service.listArcAccounts();
    expect(accounts.map((a) => a.id)).toEqual([
      "pool:chatgpt-1",
      "pool:claude-1",
      "omp:kimi-code:7",
    ]);
    const { sources } = await service.listArcAccountsDetailed();
    expect(sources).toMatchObject([
      { kind: "pool", state: "ready" },
      { kind: "omp", state: "ready" },
    ]);
  });

  it("keeps pool and OMP records separate even with identical emails", async () => {
    const ompOpenAi = account({
      id: "omp:openai-codex:3",
      sourceId: "openai-codex:3",
      sourceKind: "omp",
      providerFamily: "openai-codex",
      providerLabel: "ChatGPT Plus/Pro (Codex Subscription)",
      accountKey: "omp:openai-codex:other-id",
      email: "adnan@example.com",
      availableThrough: ["omp"],
    });
    const service = new ArcAccountService({
      sources: [new FakeSource("pool", [poolCodex]), new FakeOmpSource([ompOpenAi])],
    });
    const accounts = await service.listArcAccounts();
    expect(accounts).toHaveLength(2);
    expect(new Set(accounts.map((a) => a.sourceKind))).toEqual(
      new Set(["pool", "omp"]),
    );
  });

  it("keeps pool accounts when the OMP source fails", async () => {
    const omp = new FakeOmpSource([ompKimi]);
    omp.fail = new Error("omp broker down");
    const service = new ArcAccountService({ sources: [new FakeSource("pool", [poolCodex]), omp] });
    const { accounts, sources } = await service.listArcAccountsDetailed();
    expect(accounts.map((a) => a.id)).toEqual(["pool:chatgpt-1"]);
    expect(sources).toMatchObject([
      { kind: "pool", state: "ready" },
      { kind: "omp", state: "unavailable", detail: "omp broker down" },
    ]);
    // OMP readiness is unknown, not "no account".
    expect(await service.accountStateForAgent("omp")).toBe("unknown");
    expect(await service.accountStateForAgent("codex")).toBe("connected");
  });

  it("keeps OMP accounts when the pool source fails", async () => {
    const pool = new FakeSource("pool", [poolCodex]);
    pool.fail = new Error("pool plugin unavailable");
    const service = new ArcAccountService({ sources: [pool, new FakeOmpSource([ompKimi])] });
    const { accounts, sources } = await service.listArcAccountsDetailed();
    expect(accounts.map((a) => a.id)).toEqual(["omp:kimi-code:7"]);
    expect(sources).toMatchObject([
      { kind: "pool", state: "unavailable" },
      { kind: "omp", state: "ready" },
    ]);
    expect(await service.accountStateForAgent("omp")).toBe("connected");
    // Codex depends solely on the pool: its state is unknown, and it must
    // not silently become "no account" either.
    expect(await service.accountStateForAgent("codex")).toBe("unknown");
  });

  it("throws only when every source fails", async () => {
    const pool = new FakeSource("pool", [poolCodex]);
    pool.fail = new Error("pool down");
    const omp = new FakeOmpSource([ompKimi]);
    omp.fail = new Error("omp down");
    const service = new ArcAccountService({ sources: [pool, omp] });
    await expect(service.listArcAccounts()).rejects.toMatchObject({
      code: "account-source-unavailable",
    });
  });

  it("routes operations by source prefix across both sources", async () => {
    const service = new ArcAccountService({
      sources: [new FakeSource("pool", [poolCodex]), new FakeOmpSource([ompKimi])],
    });
    expect(await service.getArcAccount("omp:kimi-code:7")).toMatchObject({
      sourceKind: "omp",
    });
    expect(await service.getArcAccount("pool:chatgpt-1")).toMatchObject({
      sourceKind: "pool",
    });
    await expect(service.getArcAccount("unknown:1")).rejects.toMatchObject({
      code: "account-not-found",
    });
  });

  it("reports not-connected for a healthy OMP source with zero accounts", async () => {
    const service = new ArcAccountService({
      sources: [new FakeSource("pool", [poolCodex]), new FakeOmpSource([])],
    });
    expect(await service.accountStateForAgent("omp")).toBe("not-connected");
    expect(await service.hasConnectedAccount("omp")).toBe(false);
  });
});

describe("ArcAccountService OMP provider login", () => {
  it("single-flights duplicate starts for the same provider", async () => {
    const omp = new FakeOmpSource([]);
    const service = new ArcAccountService({ sources: [omp] });
    const [first, second] = await Promise.all([
      service.startOmpProviderLogin("kimi-code"),
      service.startOmpProviderLogin("kimi-code"),
    ]);
    expect(omp.loginStarts).toBe(1);
    expect(second.sessionId).toBe(first.sessionId);
    expect(service.getLoginState("omp:kimi-code")).toBe("waiting-for-user");
  });

  it("single-flights per provider, not globally", async () => {
    const omp = new FakeOmpSource([]);
    const service = new ArcAccountService({ sources: [omp] });
    await Promise.all([
      service.startOmpProviderLogin("kimi-code"),
      service.startOmpProviderLogin("deepseek"),
    ]);
    expect(omp.loginStarts).toBe(2);
  });

  it("a terminal poll clears the pending session so a retry can start", async () => {
    const omp = new FakeOmpSource([]);
    const service = new ArcAccountService({ sources: [omp] });
    const challenge = await service.startOmpProviderLogin("kimi-code");
    omp.pollResult = { state: "connected", account: ompKimi, message: null };
    const poll = await service.pollOmpProviderLogin(challenge.sessionId);
    expect(poll.state).toBe("connected");
    expect(service.getLoginState("omp:kimi-code")).toBe("idle");
    // A retry after completion starts a fresh provider attempt.
    omp.pollResult = { state: "waiting-for-user", account: null, message: null };
    await service.startOmpProviderLogin("kimi-code");
    expect(omp.loginStarts).toBe(2);
  });

  it("a failed start does not pin the single-flight slot", async () => {
    const omp = new FakeOmpSource([]);
    omp.loginError = new Error("omp login blew up");
    const service = new ArcAccountService({ sources: [omp] });
    await expect(service.startOmpProviderLogin("kimi-code")).rejects.toThrow(
      "omp login blew up",
    );
    omp.loginError = null;
    await service.startOmpProviderLogin("kimi-code");
    expect(omp.loginStarts).toBe(2);
  });
});
