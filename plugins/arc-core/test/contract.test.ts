import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type {
  ArcAccount,
  ArcAccountSourceStatus,
  ArcAgentStatus,
  ArcCurrentAgentUsage,
  ArcOmpLoginChallenge,
  ArcOmpLoginPoll,
  ArcOmpProvider,
  ArcRuntimeUpdateOutcome,
  ArcUsageSnapshot,
} from "@bb/arc-domains";
import type { RollbackArcRuntimeVersionResult } from "@bb/arc-domains/arc-runtime";
import {
  arcAccountSchema,
  arcAccountSourceStatusSchema,
  arcAgentStatusSchema,
  arcCurrentAgentUsageSchema,
  arcOmpLoginChallengeSchema,
  arcOmpLoginPollSchema,
  arcOmpProviderSchema,
  arcRuntimeRollbackOutcomeSchema,
  arcRuntimeUpdateDiscoverySchema,
  arcRuntimeUpdateOutcomeSchema,
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
    knownGoodVersion: "18.2.6",
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
  identityKey: null,
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
  activeAccount: null,
  activeAccountUnknown: true,
};

const resolvedOmpAccount: ArcCurrentAgentUsage["activeAccount"] = {
  accountKey: null,
  accountSourceId: "omp:opencode-go:1",
  providerLabel: "OpenCode Go",
  providerFamily: "opencode-go",
  planLabel: null,
  accountEmail: null,
  resolvedBy: "provider",
};

// A resolved OMP thread: the account Arc named from the provider the thread's
// selected model belongs to. The api-key case carries no canonical accountKey,
// so the source-local id must survive the wire.
const resolvedOmpUsage: ArcCurrentAgentUsage = {
  agentId: "omp",
  thread: null,
  resources: [],
  activeAccount: resolvedOmpAccount,
  activeAccountUnknown: false,
};

// The domain type's latestTrusted is a full ArcRuntimeRelease; the wire
// schema deliberately narrows it (server.ts's toArcRuntimeUpdateDiscoverySummary
// maps runtimeId/artifactKind/expectedExecutableVersion/executableSha256
// away before it ever reaches this boundary), so this fixture matches what
// actually crosses the wire, not the raw domain shape.
const updateDiscovery: z.infer<typeof arcRuntimeUpdateDiscoverySchema> = {
  runtimeId: "codex",
  installedVersions: ["0.155.1", "0.156.0"],
  activeVersion: "0.155.1",
  knownGoodVersion: "0.155.1",
  latestTrusted: {
    version: "0.156.0",
    platform: "darwin-arm64",
    releaseTag: "rust-v0.156.0",
    assetName: "codex-aarch64-apple-darwin.tar.gz",
    downloadUrl:
      "https://github.com/openai/codex/releases/download/rust-v0.156.0/codex-aarch64-apple-darwin.tar.gz",
    sha256: "b".repeat(64),
    license: "Apache-2.0",
  },
  latestTrustedCompatibility: "untested",
  latestTrustedCompatibilityReason: "version is newer than the tested maximum",
  updateAvailable: true,
  rollbackAvailable: false,
  discoveryError: null,
};

const updateOutcomes: ArcRuntimeUpdateOutcome[] = [
  { kind: "updated", version: "0.156.0", detail: "codex updated to 0.156.0" },
  { kind: "up-to-date", version: "0.155.1" },
  { kind: "no-trusted-update", reason: "network unreachable" },
  { kind: "staging-failed", reason: "digest mismatch" },
  { kind: "pre-activation-health-failed", reason: "doctor did not complete" },
  { kind: "activation-failed", reason: "staged executable missing" },
  {
    kind: "post-activation-unhealthy-rolled-back",
    from: "0.156.0",
    to: "0.155.1",
    reason: "app-server did not start",
  },
  {
    kind: "post-activation-unhealthy-no-rollback-target",
    version: "0.156.0",
    reason: "app-server did not start",
  },
];

const rollbackOutcomes: RollbackArcRuntimeVersionResult[] = [
  { kind: "rolled-back", from: "0.156.0", to: "0.155.1" },
  { kind: "unavailable", reason: "no rollback target recorded" },
  { kind: "failed", reason: "rollback produced no result" },
];

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
    expect(() =>
      arcCurrentAgentUsageSchema.parse(resolvedOmpUsage),
    ).not.toThrow();
    expect(() =>
      arcRuntimeUpdateDiscoverySchema.parse(updateDiscovery),
    ).not.toThrow();
    for (const outcome of updateOutcomes) {
      expect(() => arcRuntimeUpdateOutcomeSchema.parse(outcome)).not.toThrow();
    }
    for (const outcome of rollbackOutcomes) {
      expect(() =>
        arcRuntimeRollbackOutcomeSchema.parse(outcome),
      ).not.toThrow();
    }
  });

  it("rejects unknown fields so secrets cannot ride along", () => {
    expect(() =>
      arcAccountSchema.parse({ ...account, accessToken: "sk-secret" }),
    ).toThrow();
    expect(() =>
      arcCurrentAgentUsageSchema.parse({
        ...resolvedOmpUsage,
        activeAccount: { ...resolvedOmpAccount, brokerToken: "t" },
      }),
    ).toThrow();
    expect(() =>
      arcAgentStatusSchema.parse({ ...agentStatus, brokerToken: "t" }),
    ).toThrow();
    expect(() =>
      arcRuntimeUpdateDiscoverySchema.parse({
        ...updateDiscovery,
        latestTrusted: {
          ...updateDiscovery.latestTrusted,
          runtimeId: "codex",
          artifactKind: "archive",
          executableSha256: "b".repeat(64),
          expectedExecutableVersion: "0.156.0",
        },
      }),
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
