import { describe, expect, it } from "vitest";
import type {
  ArcAccount,
  ArcAccountSourceStatus,
  ArcAgentStatus,
  ArcCurrentAgentUsage,
  ArcOmpLoginChallenge,
  ArcOmpLoginPoll,
  ArcOmpProvider,
  ArcUsageSnapshot,
} from "@bb/arc-domains";
import {
  arcAccountSchema,
  arcAccountSourceStatusSchema,
  arcAgentStatusSchema,
  arcCurrentAgentUsageSchema,
  arcOmpLoginChallengeSchema,
  arcOmpLoginPollSchema,
  arcOmpProviderSchema,
  arcUsageSnapshotSchema,
} from "../src/contract.js";

// Representative full-fidelity domain objects. If a domain type gains a
// field or changes a literal, these parses fail — that is the drift alarm.
const agentStatus: ArcAgentStatus = {
  id: "omp",
  displayName: "OMP",
  runtimeId: "omp",
  providerId: "acp-omp",
  runtime: {
    state: "ready-with-warning",
    version: "18.2.6",
    compatibility: "untested",
    compatibilityReason: "version not covered by the compatibility policy",
    source: "arc-bundled",
  },
  provider: { state: "unknown" },
  account: { state: "connected" },
  overallState: "ready",
  actions: [
    { id: "prepare", available: false, reason: "runtime is already prepared" },
    { id: "repair", available: false, reason: "runtime is not broken" },
    { id: "connect-account", available: false },
  ],
  observedAt: 1_700_000_000_000,
};

const account: ArcAccount = {
  id: "pool:openai:acc-1",
  sourceId: "openai-code:acc-1",
  sourceKind: "pool",
  providerFamily: "openai",
  providerLabel: "ChatGPT",
  accountKey: "openai:chatgpt:acc-1",
  email: "adn***@example.com",
  planLabel: "Plus",
  authState: "connected",
  enabled: true,
  availableThrough: ["codex"],
  observedAt: 1_700_000_000_000,
};

const sourceStatus: ArcAccountSourceStatus = {
  kind: "omp",
  state: "unavailable",
  detail: "omp runtime not prepared",
  checkedAt: 1_700_000_000_000,
};

const ompProvider: ArcOmpProvider = {
  id: "kimi-code",
  displayName: "Kimi Code",
  authMethod: "oauth",
  connectionState: "connected",
  hasAccounts: true,
};

const ompChallenge: ArcOmpLoginChallenge = {
  provider: "deepseek",
  sessionId: "session-1",
  kind: "api-key",
  flow: "browser",
  userCode: null,
  authorizeUrl: null,
  instructions: "Paste an API key.",
  expiresAt: null,
};

const ompPoll: ArcOmpLoginPoll = {
  state: "waiting-for-user",
  account: null,
  message: null,
};

const snapshot: ArcUsageSnapshot = {
  generatedAt: 1_700_000_000_000,
  resources: [
    {
      id: "omp:kimi-code:omp:kimi-code:3",
      sourceKind: "omp",
      accountKey: "omp:kimi-code:k1",
      accountSourceId: "omp:3",
      providerFamily: "kimi-code",
      providerLabel: "Kimi Code",
      accountEmail: "adn***@example.com",
      planLabel: null,
      modelLabel: null,
      agentIds: ["omp"],
      windows: [
        {
          id: "omp:kimi-code:omp:kimi-code:3:rolling",
          label: "Rolling 3 hours",
          kind: "custom",
          status: "ok",
          usedPercent: 50,
          remainingPercent: 50,
          usedAmount: null,
          limitAmount: null,
          remainingAmount: null,
          unit: null,
          resetsAt: null,
          observedAt: 1_700_000_000_000,
          source: "omp",
        },
        {
          id: "omp:kimi-code:omp:kimi-code:3:credit",
          label: "Credit",
          kind: "custom",
          status: null,
          usedPercent: null,
          remainingPercent: null,
          usedAmount: null,
          limitAmount: null,
          remainingAmount: 7.32,
          unit: "usd",
          resetsAt: null,
          observedAt: 1_700_000_000_000,
          source: "omp",
        },
      ],
      observedAt: 1_700_000_000_000,
      fetchedAt: 1_700_000_000_100,
      stale: false,
      status: "available",
      unavailableReason: null,
      credentialDisabled: false,
      message: null,
      sources: ["omp"],
    },
    {
      id: "omp:deepseek:omp:deepseek:9",
      sourceKind: "omp",
      accountKey: "omp:deepseek:d9",
      accountSourceId: "omp:9",
      providerFamily: "deepseek",
      providerLabel: "DeepSeek",
      accountEmail: null,
      planLabel: null,
      modelLabel: null,
      agentIds: ["omp"],
      windows: [],
      observedAt: null,
      fetchedAt: 1_700_000_000_100,
      stale: false,
      status: "unavailable",
      unavailableReason: "not-exposed",
      credentialDisabled: false,
      message: null,
      sources: ["omp"],
    },
  ],
  sources: [
    { kind: "pool", state: "ready", detail: null, checkedAt: 1_700_000_000_000 },
    {
      kind: "omp",
      state: "unavailable",
      detail: "broker unreachable",
      checkedAt: 1_700_000_000_000,
    },
  ],
};

const currentUsage: ArcCurrentAgentUsage = {
  agentId: "codex",
  thread: null,
  resources: [],
  activeAccountUnknown: true,
};

describe("arc wire contract", () => {
  it("accepts full-fidelity domain objects without drift", () => {
    expect(() => arcAgentStatusSchema.parse(agentStatus)).not.toThrow();
    expect(() => arcAccountSchema.parse(account)).not.toThrow();
    expect(() => arcAccountSourceStatusSchema.parse(sourceStatus)).not.toThrow();
    expect(() => arcOmpProviderSchema.parse(ompProvider)).not.toThrow();
    expect(() => arcOmpLoginChallengeSchema.parse(ompChallenge)).not.toThrow();
    expect(() => arcOmpLoginPollSchema.parse(ompPoll)).not.toThrow();
    expect(() => arcUsageSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(() => arcCurrentAgentUsageSchema.parse(currentUsage)).not.toThrow();
  });

  it("rejects unknown fields so secrets cannot ride along", () => {
    expect(() =>
      arcAccountSchema.parse({ ...account, accessToken: "sk-secret" }),
    ).toThrow();
    expect(() =>
      arcAgentStatusSchema.parse({ ...agentStatus, brokerToken: "t" }),
    ).toThrow();
    expect(() =>
      arcUsageSnapshotSchema.parse({
        ...snapshot,
        resources: [
          { ...snapshot.resources[0]!, apiKey: "sk-x" },
          ...snapshot.resources.slice(1),
        ],
      }),
    ).toThrow();
  });

  it("serialized payloads carry no secret-shaped values", () => {
    const payloads = [
      agentStatus,
      account,
      ompProvider,
      ompChallenge,
      ompPoll,
      snapshot,
      currentUsage,
    ].map((value) => JSON.stringify(value));
    const secretPattern =
      /access[_-]?token|refresh[_-]?token|authorization|bearer|password|cookie|secret|pkce/i;
    for (const payload of payloads) {
      // "api-key"/"api_key" appear only as public auth-method enum literals;
      // after removing those exact literals no key-shaped text may remain.
      const withoutAuthMethodLiterals = payload
        .replace(/"api-key"/g, "")
        .replace(/"api_key"/g, "");
      expect(secretPattern.test(payload)).toBe(false);
      expect(/api[_-]?key/i.test(withoutAuthMethodLiterals)).toBe(false);
    }
  });
});
