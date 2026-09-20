import { describe, expect, it } from "vitest";
import {
  ompAccountPoolFileContent,
  parseArcOmpAccountKey,
  resolveArcOmpExecutionPin,
} from "../src/arc-account/omp-execution-pin.js";
import type { ArcAccount } from "../src/arc-account/types.js";

const NOW = 1_800_000_000_000;

function ompAccount(args: {
  id: string;
  providerFamily: string;
  accountKey: string | null;
  identityKey: string | null;
}): ArcAccount {
  return {
    id: args.id,
    sourceId: args.id,
    sourceKind: "omp",
    providerFamily: args.providerFamily,
    providerLabel: args.providerFamily,
    accountKey: args.accountKey,
    identityKey: args.identityKey,
    email: null,
    planLabel: null,
    authState: "connected",
    enabled: true,
    availableThrough: ["omp"],
    observedAt: NOW,
  };
}

const KIMI_A = ompAccount({
  id: "omp:kimi-code:2",
  providerFamily: "kimi-code",
  accountKey: "omp:kimi-code:acct-a",
  identityKey: "account:acct-a",
});
const KIMI_B = ompAccount({
  id: "omp:kimi-code:5",
  providerFamily: "kimi-code",
  accountKey: "omp:kimi-code:acct-b",
  identityKey: "account:acct-b",
});
const API_KEY_ONLY = ompAccount({
  id: "omp:deepseek:9",
  providerFamily: "deepseek",
  accountKey: null,
  identityKey: "api_key:sk-***",
});

describe("parseArcOmpAccountKey", () => {
  it("splits provider and provider-issued account id", () => {
    expect(parseArcOmpAccountKey("omp:kimi-code:acct-a")).toEqual({
      provider: "kimi-code",
      accountId: "acct-a",
    });
    expect(parseArcOmpAccountKey("omp:anthropic:4ef2-uuid")).toEqual({
      provider: "anthropic",
      accountId: "4ef2-uuid",
    });
  });

  it("rejects keys that do not name an OMP provider and account", () => {
    for (const key of [
      "openai:chatgpt:acc-1",
      "anthropic:account:uuid-1",
      "omp:",
      "omp::acct-a",
      "omp:kimi-code",
      "omp:kimi-code:",
    ]) {
      expect(parseArcOmpAccountKey(key)).toBeNull();
    }
  });
});

describe("resolveArcOmpExecutionPin", () => {
  it("leaves an unpinned thread to OMP's own selection", () => {
    expect(
      resolveArcOmpExecutionPin({ accounts: [KIMI_A, KIMI_B], accountKey: null }),
    ).toEqual({ kind: "unpinned" });
  });

  it("pins the thread to the credential its account key names", () => {
    expect(
      resolveArcOmpExecutionPin({
        accounts: [KIMI_A, KIMI_B],
        accountKey: "omp:kimi-code:acct-b",
      }),
    ).toEqual({
      kind: "pinned",
      provider: "kimi-code",
      identityKey: "account:acct-b",
    });
  });

  it("fails closed when the pinned account is gone, keeping the provider", () => {
    expect(
      resolveArcOmpExecutionPin({
        accounts: [KIMI_B],
        accountKey: "omp:kimi-code:acct-a",
      }),
    ).toEqual({ kind: "unavailable", provider: "kimi-code" });
  });

  it("fails closed when the stored credential has no identity to pin by", () => {
    expect(
      resolveArcOmpExecutionPin({
        accounts: [
          ompAccount({
            id: "omp:kimi-code:7",
            providerFamily: "kimi-code",
            accountKey: "omp:kimi-code:acct-c",
            identityKey: null,
          }),
        ],
        accountKey: "omp:kimi-code:acct-c",
      }),
    ).toEqual({ kind: "unavailable", provider: "kimi-code" });
  });

  it("reports a non-OMP pin as a mismatch instead of ignoring it", () => {
    expect(
      resolveArcOmpExecutionPin({
        accounts: [KIMI_A],
        accountKey: "openai:chatgpt:acc-1",
      }),
    ).toEqual({ kind: "not-omp-account" });
  });
});

describe("ompAccountPoolFileContent", () => {
  const knownProviders = ["kimi-code", "anthropic", "deepseek"];

  it("contributes nothing for an unpinned thread", () => {
    expect(
      ompAccountPoolFileContent({
        pin: { kind: "unpinned" },
        knownProviders,
      }),
    ).toBeNull();
  });

  it("allows exactly the pinned credential, not the provider's others", () => {
    const content = ompAccountPoolFileContent({
      pin: resolveArcOmpExecutionPin({
        accounts: [KIMI_A, KIMI_B],
        accountKey: "omp:kimi-code:acct-a",
      }),
      knownProviders,
    });
    expect(content).toEqual({ "kimi-code": ["account:acct-a"] });
    expect(JSON.stringify(content)).not.toContain("acct-b");
  });

  it("excludes the whole provider when its account is unavailable", () => {
    expect(
      ompAccountPoolFileContent({
        pin: { kind: "unavailable", provider: "kimi-code" },
        knownProviders,
      }),
    ).toEqual({ "kimi-code": [] });
  });

  it("excludes every stored provider for a pin that is not an OMP account", () => {
    expect(
      ompAccountPoolFileContent({
        pin: { kind: "not-omp-account" },
        knownProviders: ["kimi-code", "deepseek", "kimi-code"],
      }),
    ).toEqual({ "kimi-code": [], deepseek: [] });
  });

  it("never widens past the pinned provider when unrelated accounts exist", () => {
    const content = ompAccountPoolFileContent({
      pin: resolveArcOmpExecutionPin({
        accounts: [KIMI_A, KIMI_B, API_KEY_ONLY],
        accountKey: "omp:kimi-code:acct-b",
      }),
      knownProviders,
    });
    expect(Object.keys(content ?? {})).toEqual(["kimi-code"]);
  });
});
