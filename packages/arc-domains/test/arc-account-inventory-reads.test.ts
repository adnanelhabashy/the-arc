import { describe, expect, it } from "vitest";
import { ArcAccountService } from "../src/arc-account/service.js";
import type { ArcAccount, ArcAccountSource } from "../src/arc-account/types.js";

// Phase 14: one UI frame reads the account inventory several times at once
// (`arc.accounts.list` plus every row of `arc.agents.list`, where Codex and
// Claude Code both resolve through the pool). Concurrent reads share one
// source read; a read that follows the previous one still observes the
// source's current state.

const NOW = 1_800_000_000_000;

function arcAccount(overrides: Partial<ArcAccount> = {}): ArcAccount {
  return {
    id: "pool:acct-1",
    sourceId: "acct-1",
    sourceKind: "pool",
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountKey: "openai:chatgpt:acc-1",
    identityKey: null,
    email: "adnan@example.com",
    planLabel: "Plus",
    authState: "connected",
    enabled: true,
    availableThrough: ["codex"],
    observedAt: NOW,
    ...overrides,
  };
}

// The login surface is not exercised here; a source that is asked for it has
// failed the test.
function unused(): never {
  throw new Error("login surface is not used by these tests");
}

class CountingSource implements ArcAccountSource {
  readonly kind = "pool" as const;
  reorderAccounts = unused;
  startOpenAiLogin = unused;
  pollOpenAiLogin = unused;
  cancelOpenAiLogin = unused;
  startClaudeLogin = unused;
  completeClaudeLogin = unused;
  accounts: ArcAccount[] = [arcAccount()];
  listCalls = 0;
  private gate: Promise<void> | null = null;

  holdNextList(): () => void {
    // Executor form: this package's tsconfig lib predates
    // Promise.withResolvers.
    let release: () => void = () => undefined;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      const gate = this.gate;
      this.gate = null;
      release();
      void gate;
    };
  }

  async listAccounts(): Promise<ArcAccount[]> {
    this.listCalls += 1;
    const gate = this.gate;
    if (gate !== null) await gate;
    return this.accounts;
  }

  async getAccount(sourceId: string): Promise<ArcAccount> {
    const account = this.accounts.find((entry) => entry.sourceId === sourceId);
    if (account === undefined) throw new Error(`missing ${sourceId}`);
    return account;
  }

  async setAccountEnabled(sourceId: string, enabled: boolean): Promise<ArcAccount> {
    return { ...(await this.getAccount(sourceId)), enabled };
  }

  async removeAccount(sourceId: string): Promise<void> {
    this.accounts = this.accounts.filter((entry) => entry.sourceId !== sourceId);
  }

  async setAccountPriority(sourceId: string, priority: number): Promise<ArcAccount> {
    void priority;
    return this.getAccount(sourceId);
  }
}

function makeService(source: ArcAccountSource): ArcAccountService {
  return new ArcAccountService({ sources: [source], now: () => NOW });
}

describe("ArcAccountService inventory reads", () => {
  it("coalesces concurrent inventory reads into one source read", async () => {
    const source = new CountingSource();
    const release = source.holdNextList();
    const service = makeService(source);

    const reads = Promise.all([
      service.listArcAccountsDetailed(),
      service.listArcAccounts(),
      service.accountStateForAgent("codex"),
      service.accountStateForAgent("claude-code"),
    ]);
    release();
    await reads;

    expect(source.listCalls).toBe(1);
  });

  it("still observes the source on the read that follows", async () => {
    const source = new CountingSource();
    const service = makeService(source);

    expect(await service.hasConnectedAccount("codex")).toBe(true);
    source.accounts = [];
    expect(await service.hasConnectedAccount("codex")).toBe(false);
    expect(source.listCalls).toBe(2);
  });

  it("does not cache a failed inventory read", async () => {
    const source = new CountingSource();
    let failing = true;
    const flaky: ArcAccountSource = {
      kind: "pool",
      reorderAccounts: unused,
      startOpenAiLogin: unused,
      pollOpenAiLogin: unused,
      cancelOpenAiLogin: unused,
      startClaudeLogin: unused,
      completeClaudeLogin: unused,
      async listAccounts() {
        source.listCalls += 1;
        if (failing) throw new Error("pool unreachable");
        return source.accounts;
      },
      getAccount: (id) => source.getAccount(id),
      setAccountEnabled: (id, enabled) => source.setAccountEnabled(id, enabled),
      removeAccount: (id) => source.removeAccount(id),
      setAccountPriority: (id, priority) =>
        source.setAccountPriority(id, priority),
    };
    const service = makeService(flaky);

    await expect(service.listArcAccountsDetailed()).rejects.toMatchObject({
      code: "account-source-unavailable",
    });
    failing = false;
    expect((await service.listArcAccountsDetailed()).accounts).toHaveLength(1);
  });
});
