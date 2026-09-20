import { describe, expect, it } from "vitest";
import { ArcAccountService } from "../src/arc-account/service.js";
import {
  ArcAccountError,
  type ArcAccount,
  type ArcAccountLoginChallenge,
  type ArcAccountProviderFamily,
  type ArcAccountSource,
} from "../src/arc-account/types.js";

const NOW = 1_800_000_000_000;

function arcAccount(overrides: Partial<ArcAccount> = {}): ArcAccount {
  return {
    id: "pool:acct-1",
    sourceId: "acct-1",
    sourceKind: "pool",
    providerFamily: "anthropic",
    providerLabel: "Claude",
    accountKey: "anthropic:account:uuid-1",
    identityKey: null,
    email: "adnan@example.com",
    planLabel: "max",
    authState: "connected",
    enabled: true,
    availableThrough: ["claude-code"],
    observedAt: NOW,
    ...overrides,
  };
}

class FakeSource implements ArcAccountSource {
  readonly kind = "pool" as const;
  accounts: ArcAccount[] = [];
  calls: string[] = [];
  loginStarts = 0;
  pollOutcomes: Array<
    | { state: "waiting-for-user"; account: null; message: null }
    | { state: "connected"; account: ArcAccount; message: null }
    | { state: "failed"; account: null; message: string }
  > = [];
  cancelled: string[] = [];
  startDelay: Promise<void> | null = null;
  startError: Error | null = null;

  async listAccounts(): Promise<ArcAccount[]> {
    this.calls.push("listAccounts");
    return this.accounts;
  }

  async getAccount(sourceId: string): Promise<ArcAccount> {
    this.calls.push("getAccount");
    const account = this.accounts.find((entry) => entry.sourceId === sourceId);
    if (account === undefined) throw new ArcAccountError("account-not-found", sourceId);
    return account;
  }

  async setAccountEnabled(sourceId: string, enabled: boolean): Promise<ArcAccount> {
    this.calls.push(`setAccountEnabled:${enabled}`);
    const account = await this.getAccount(sourceId);
    return { ...account, enabled };
  }

  async removeAccount(sourceId: string): Promise<void> {
    this.calls.push("removeAccount");
    await this.getAccount(sourceId);
    this.accounts = this.accounts.filter((entry) => entry.sourceId !== sourceId);
  }

  async setAccountPriority(sourceId: string, priority: number): Promise<ArcAccount> {
    this.calls.push(`setAccountPriority:${priority}`);
    return this.getAccount(sourceId);
  }

  async reorderAccounts(
    providerFamily: ArcAccountProviderFamily,
    orderedSourceIds: string[],
  ): Promise<void> {
    this.calls.push(`reorder:${providerFamily}:${orderedSourceIds.join(",")}`);
  }

  async startOpenAiLogin() {
    this.calls.push("startOpenAiLogin");
    this.loginStarts += 1;
    if (this.startDelay !== null) await this.startDelay;
    if (this.startError !== null) throw this.startError;
    return {
      provider: "openai" as const,
      sessionId: `openai-session-${this.loginStarts}`,
      verificationUri: "https://chatgpt.com/connect",
      userCode: "ABCD-EFGH",
      expiresAt: NOW + 60_000,
      intervalMs: 1_000,
    };
  }

  async pollOpenAiLogin() {
    this.calls.push("pollOpenAiLogin");
    const outcome = this.pollOutcomes.shift();
    if (outcome === undefined) {
      return { state: "waiting-for-user" as const, account: null, message: null };
    }
    return outcome;
  }

  async cancelOpenAiLogin(sessionId: string): Promise<void> {
    this.calls.push("cancelOpenAiLogin");
    this.cancelled.push(sessionId);
  }

  async startClaudeLogin(): Promise<ArcClaudeChallenge> {
    this.calls.push("startClaudeLogin");
    this.loginStarts += 1;
    return {
      provider: "anthropic" as const,
      sessionId: `claude-session-${this.loginStarts}`,
      authorizeUrl: "https://claude.ai/oauth/authorize?xyz",
      expiresAt: null,
    };
  }

  async completeClaudeLogin() {
    this.calls.push("completeClaudeLogin");
    return arcAccount();
  }
}

type ArcClaudeChallenge = Extract<ArcAccountLoginChallenge, { provider: "anthropic" }>;

function makeService(source: FakeSource, now: () => number = () => NOW) {
  return new ArcAccountService({ sources: [source], now });
}

describe("ArcAccountService inventory and routing", () => {
  it("lists accounts across sources without dedup", async () => {
    const source = new FakeSource();
    source.accounts = [
      arcAccount(),
      arcAccount({ id: "pool:acct-2", sourceId: "acct-2", accountKey: null }),
    ];
    const service = makeService(source);
    expect(await service.listArcAccounts()).toHaveLength(2);
  });

  it("routes id-prefixed operations to the owning source", async () => {
    const source = new FakeSource();
    source.accounts = [arcAccount()];
    const service = makeService(source);

    await service.setAccountEnabled("pool:acct-1", false);
    await service.setAccountPriority("pool:acct-1", 3);
    await service.removeAccount("pool:acct-1");
    expect(source.calls).toEqual([
      "setAccountEnabled:false",
      "getAccount",
      "setAccountPriority:3",
      "getAccount",
      "removeAccount",
      "getAccount",
    ]);

    source.accounts = [arcAccount()];
    await expect(
      service.setAccountEnabled("omp:other", true),
    ).rejects.toMatchObject({ code: "account-not-found" });
  });

  it("readiness: one enabled connected account suffices; OpenAI never makes Claude connected", async () => {
    const source = new FakeSource();
    const service = makeService(source);

    source.accounts = [];
    expect(await service.hasConnectedAccount("codex")).toBe(false);
    expect(await service.hasConnectedAccount("claude-code")).toBe(false);

    source.accounts = [
      arcAccount({
        providerFamily: "openai",
        providerLabel: "ChatGPT",
        accountKey: "openai:chatgpt:1",
        availableThrough: ["codex"],
      }),
    ];
    expect(await service.hasConnectedAccount("codex")).toBe(true);
    expect(await service.hasConnectedAccount("claude-code")).toBe(false);
    // OMP is never satisfied by pool accounts (Phase 8 owns OMP accounts).
    expect(await service.hasConnectedAccount("omp")).toBe(false);

    source.accounts = [
      arcAccount({ enabled: false, authState: "disabled" }),
    ];
    expect(await service.hasConnectedAccount("claude-code")).toBe(false);

    source.accounts = [arcAccount({ authState: "error" })];
    expect(await service.hasConnectedAccount("claude-code")).toBe(false);
  });

  it("inventory reads are side-effect-free: no login or refresh calls", async () => {
    const source = new FakeSource();
    source.accounts = [arcAccount()];
    const service = makeService(source);

    await service.listArcAccounts();
    await service.getArcAccount("pool:acct-1");
    await service.hasConnectedAccount("codex");

    expect(
      source.calls.every((call) =>
        ["listAccounts", "getAccount"].includes(call),
      ),
    ).toBe(true);
    expect(source.loginStarts).toBe(0);
  });
});

describe("ArcAccountService login single-flight", () => {
  it("duplicate OpenAI starts join into one provider login attempt", async () => {
    const source = new FakeSource();
    let release!: () => void;
    source.startDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = makeService(source);

    const first = service.startOpenAiLogin();
    const second = service.startOpenAiLogin();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.sessionId).toBe(b.sessionId);
    expect(source.loginStarts).toBe(1);
    expect(service.getLoginState("openai")).toBe("waiting-for-user");
  });

  it("a failed start clears the pending state so a retry is possible", async () => {
    const source = new FakeSource();
    source.startError = new Error("pool offline");
    const service = makeService(source);

    await expect(service.startOpenAiLogin()).rejects.toThrow("pool offline");
    expect(service.getLoginState("openai")).toBe("idle");

    source.startError = null;
    const challenge = await service.startOpenAiLogin();
    expect(challenge.sessionId).toBe("openai-session-2");
    expect(service.getLoginState("openai")).toBe("waiting-for-user");
  });

  it("a terminal poll result clears the pending session", async () => {
    const source = new FakeSource();
    const service = makeService(source);
    await service.startOpenAiLogin();
    expect(service.getLoginState("openai")).toBe("waiting-for-user");

    source.pollOutcomes.push({
      state: "connected",
      account: arcAccount({
        providerFamily: "openai",
        providerLabel: "ChatGPT",
        accountKey: "openai:chatgpt:9",
        availableThrough: ["codex"],
      }),
      message: null,
    });
    const poll = await service.pollOpenAiLogin("openai-session-1");
    expect(poll.state).toBe("connected");
    expect(service.getLoginState("openai")).toBe("idle");

    // A new start after completion begins a fresh provider session.
    const next = await service.startOpenAiLogin();
    expect(next.sessionId).toBe("openai-session-2");
  });

  it("cancel clears the pending session and delegates to the pool", async () => {
    const source = new FakeSource();
    const service = makeService(source);
    const challenge = await service.startOpenAiLogin();
    await service.cancelOpenAiLogin(challenge.sessionId);
    expect(source.cancelled).toEqual([challenge.sessionId]);
    expect(service.getLoginState("openai")).toBe("idle");
  });

  it("an expired pending session no longer blocks a fresh start", async () => {
    const source = new FakeSource();
    let now = NOW;
    const service = makeService(source, () => now);
    const first = await service.startOpenAiLogin();
    expect(first.sessionId).toBe("openai-session-1");

    now = NOW + 120_000; // past the challenge's expiresAt
    const second = await service.startOpenAiLogin();
    expect(second.sessionId).toBe("openai-session-2");
  });

  it("Claude login single-flights and completes once", async () => {
    const source = new FakeSource();
    const service = makeService(source);

    const [a, b] = await Promise.all([
      service.startClaudeLogin(),
      service.startClaudeLogin(),
    ]);
    expect(a.sessionId).toBe(b.sessionId);
    expect(source.loginStarts).toBe(1);
    expect(service.getLoginState("anthropic")).toBe("waiting-for-user");

    const account = await service.completeClaudeLogin(
      a.sessionId,
      "https://console.anthropic.com/oauth/code/callback?code=abc",
    );
    expect(account.accountKey).toBe("anthropic:account:uuid-1");
    expect(service.getLoginState("anthropic")).toBe("idle");
  });
});
