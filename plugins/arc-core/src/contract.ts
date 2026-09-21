import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// Wire contract for the Arc Core service plugin. These schemas are the
// renderer-facing boundary: strict objects, no passthrough, and no field
// that could carry a token, key, or credential. Domain types in
// @bb/arc-domains are the source of truth; a structural drift fails the
// contract tests in test/contract.test.ts.

export const arcAgentIdSchema = z.enum(["codex", "claude-code", "omp"]);

export const arcRuntimeStateSchema = z.enum([
  "not-prepared",
  "preparing",
  "ready",
  "ready-with-warning",
  "broken",
  "unsupported",
  "unavailable",
]);

export const arcAgentProviderStateSchema = z.enum([
  "unknown",
  "ready",
  "unavailable",
  "error",
]);

export const arcAgentAccountStateSchema = z.enum([
  "unknown",
  "not-connected",
  "connected",
  "expired",
  "error",
]);

export const arcAgentOverallStateSchema = z.enum([
  "not-prepared",
  "preparing",
  "runtime-ready",
  "account-required",
  "ready",
  "broken",
  "unsupported",
  "unavailable",
]);

export const arcAgentActionSchema = z
  .object({
    id: z.enum(["prepare", "repair", "open-settings", "connect-account", "update", "rollback"]),
    available: z.boolean(),
    // Omitted (not null) when the action is available — mirrors the domain
    // type's optional reason.
    reason: z.string().optional(),
  })
  .strict();

export const arcRuntimeSourceSchema = z.enum([
  "arc-bundled",
  "arc-managed-download",
  "official-managed-install",
  "external-override",
]);

export const arcAgentRuntimeStatusSchema = z
  .object({
    state: arcRuntimeStateSchema,
    version: z.string().nullable(),
    compatibility: z.enum(["supported", "untested", "blocked"]).nullable(),
    compatibilityReason: z.string().nullable(),
    source: arcRuntimeSourceSchema.nullable(),
    knownGoodVersion: z.string().nullable(),
  })
  .strict();

export const arcAgentStatusSchema = z
  .object({
    id: arcAgentIdSchema,
    displayName: z.string(),
    runtimeId: z.enum(["codex", "claude-code", "omp"]),
    providerId: z.string(),
    runtime: arcAgentRuntimeStatusSchema,
    provider: z.object({ state: arcAgentProviderStateSchema }).strict(),
    account: z.object({ state: arcAgentAccountStateSchema }).strict(),
    overallState: arcAgentOverallStateSchema,
    actions: z.array(arcAgentActionSchema),
    observedAt: z.number(),
  })
  .strict();

export const arcAccountAuthStateSchema = z.enum([
  "connected",
  "expired",
  "disabled",
  "error",
  "unknown",
]);

export const arcAccountSchema = z
  .object({
    id: z.string(),
    sourceId: z.string(),
    sourceKind: z.enum(["pool", "omp"]),
    providerFamily: z.string(),
    providerLabel: z.string(),
    accountKey: z.string().nullable(),
    identityKey: z.string().nullable(),
    email: z.string().nullable(),
    planLabel: z.string().nullable(),
    authState: arcAccountAuthStateSchema,
    enabled: z.boolean(),
    availableThrough: z.array(arcAgentIdSchema),
    observedAt: z.number(),
  })
  .strict();

export const arcAccountSourceStatusSchema = z
  .object({
    kind: z.enum(["pool", "omp"]),
    state: z.enum(["ready", "unavailable"]),
    detail: z.string().nullable(),
    checkedAt: z.number(),
  })
  .strict();

export const arcAccountLoginChallengeSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("openai"),
      sessionId: z.string(),
      verificationUri: z.string(),
      userCode: z.string(),
      expiresAt: z.number(),
      intervalMs: z.number(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("anthropic"),
      sessionId: z.string(),
      authorizeUrl: z.string(),
      expiresAt: z.number().nullable(),
    })
    .strict(),
]);

export const arcAccountLoginStateSchema = z.enum([
  "idle",
  "starting",
  "waiting-for-user",
  "authorizing",
  "connected",
  "failed",
  "expired",
  "cancelled",
]);

export const arcOpenAiLoginPollSchema = z
  .object({
    state: z.enum(["waiting-for-user", "connected", "failed"]),
    account: arcAccountSchema.nullable(),
    message: z.string().nullable(),
  })
  .strict();

export const arcOmpProviderSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    authMethod: z.enum(["oauth", "api-key", "unknown"]),
    connectionState: z.enum(["connected", "not-connected", "unknown"]),
    hasAccounts: z.boolean(),
  })
  .strict();

export const arcOmpLoginChallengeSchema = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    kind: z.enum(["oauth", "api-key"]),
    // Classified from the live broker output: browser redirect vs OAuth
    // device code (verification URL + one-time user code).
    flow: z.enum(["browser", "device"]),
    userCode: z.string().nullable(),
    authorizeUrl: z.string().nullable(),
    instructions: z.string().nullable(),
    expiresAt: z.number().nullable(),
  })
  .strict();

export const arcOmpLoginPollSchema = z
  .object({
    state: z.enum(["waiting-for-user", "connected", "failed"]),
    account: arcAccountSchema.nullable(),
    message: z.string().nullable(),
  })
  .strict();

export const arcUsageSourceKindSchema = z.enum(["pool", "omp", "thread"]);

export const arcUsageResourceStatusSchema = z.enum([
  "available",
  "unavailable",
  "error",
  "unknown",
]);

export const arcUsageUnavailableReasonSchema = z.enum([
  "not-exposed",
  "not-connected",
  "disabled",
]);

export const arcUsageWindowKindSchema = z.enum([
  "five-hour",
  "daily",
  "weekly",
  "monthly",
  "custom",
]);

export const arcUsageWindowStatusSchema = z.enum([
  "ok",
  "warning",
  "exhausted",
  "unknown",
]);

export const arcUsageUnitSchema = z.enum([
  "percent",
  "tokens",
  "requests",
  "credits",
  "usd",
  "minutes",
  "bytes",
  "unknown",
]);

export const arcUsageWindowSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    kind: arcUsageWindowKindSchema,
    status: arcUsageWindowStatusSchema.nullable(),
    usedPercent: z.number().nullable(),
    remainingPercent: z.number().nullable(),
    usedAmount: z.number().nullable(),
    limitAmount: z.number().nullable(),
    remainingAmount: z.number().nullable(),
    unit: arcUsageUnitSchema.nullable(),
    resetsAt: z.number().nullable(),
    observedAt: z.number().nullable(),
    source: arcUsageSourceKindSchema.nullable(),
  })
  .strict();

export const arcUsageResourceSchema = z
  .object({
    id: z.string(),
    sourceKind: arcUsageSourceKindSchema,
    accountKey: z.string().nullable(),
    accountSourceId: z.string().nullable(),
    providerFamily: z.string().nullable(),
    providerLabel: z.string(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    modelLabel: z.string().nullable(),
    agentIds: z.array(arcAgentIdSchema),
    windows: z.array(arcUsageWindowSchema),
    observedAt: z.number().nullable(),
    fetchedAt: z.number().nullable(),
    stale: z.boolean(),
    status: arcUsageResourceStatusSchema,
    unavailableReason: arcUsageUnavailableReasonSchema.nullable(),
    credentialDisabled: z.boolean(),
    message: z.string().nullable(),
    sources: z.array(arcUsageSourceKindSchema),
  })
  .strict();

export const arcUsageSourceStatusSchema = z
  .object({
    kind: arcUsageSourceKindSchema,
    state: z.enum(["ready", "unavailable"]),
    detail: z.string().nullable(),
    checkedAt: z.number(),
  })
  .strict();

export const arcUsageSnapshotSchema = z
  .object({
    generatedAt: z.number(),
    resources: z.array(arcUsageResourceSchema),
    sources: z.array(arcUsageSourceStatusSchema),
  })
  .strict();

export const arcActiveUsageAccountSchema = z
  .object({
    accountKey: z.string().nullable(),
    accountSourceId: z.string().nullable(),
    providerLabel: z.string(),
    providerFamily: z.string().nullable(),
    planLabel: z.string().nullable(),
    accountEmail: z.string().nullable(),
    resolvedBy: z.enum(["binding", "provider"]),
  })
  .strict();

export const arcCurrentAgentUsageSchema = z
  .object({
    agentId: arcAgentIdSchema,
    thread: arcUsageResourceSchema.nullable(),
    resources: z.array(arcUsageResourceSchema),
    activeAccount: arcActiveUsageAccountSchema.nullable(),
    activeAccountUnknown: z.boolean(),
  })
  .strict();

export const arcUnavailableErrorCode = "arc-unavailable";

export const arcStatusSchema = z
  .object({
    arcAvailable: z.boolean(),
    reason: z.string().nullable(),
  })
  .strict();

// Safe, backend-owned provenance metadata for a trusted candidate release
// (plan 2.26). The renderer can see this — none of it is secret — but never
// supplies it back: arc.agents.update takes no release argument at all, it
// re-discovers and re-verifies the trusted source itself.
export const arcRuntimeReleaseSummarySchema = z
  .object({
    version: z.string(),
    platform: z.string(),
    releaseTag: z.string(),
    assetName: z.string(),
    downloadUrl: z.string(),
    sha256: z.string(),
    license: z.string(),
  })
  .strict();

export const arcRuntimeUpdateDiscoverySchema = z
  .object({
    runtimeId: arcAgentIdSchema,
    installedVersions: z.array(z.string()),
    activeVersion: z.string().nullable(),
    knownGoodVersion: z.string().nullable(),
    latestTrusted: arcRuntimeReleaseSummarySchema.nullable(),
    latestTrustedCompatibility: z
      .enum(["supported", "untested", "blocked"])
      .nullable(),
    latestTrustedCompatibilityReason: z.string().nullable(),
    updateAvailable: z.boolean(),
    rollbackAvailable: z.boolean(),
    discoveryError: z.string().nullable(),
  })
  .strict();

export const arcRuntimeUpdateOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("updated"), version: z.string(), detail: z.string() }).strict(),
  z.object({ kind: z.literal("up-to-date"), version: z.string().nullable() }).strict(),
  z.object({ kind: z.literal("no-trusted-update"), reason: z.string() }).strict(),
  z.object({ kind: z.literal("staging-failed"), reason: z.string() }).strict(),
  z
    .object({ kind: z.literal("pre-activation-health-failed"), reason: z.string() })
    .strict(),
  z.object({ kind: z.literal("activation-failed"), reason: z.string() }).strict(),
  z
    .object({
      kind: z.literal("post-activation-unhealthy-rolled-back"),
      from: z.string(),
      to: z.string(),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("post-activation-unhealthy-no-rollback-target"),
      version: z.string(),
      reason: z.string(),
    })
    .strict(),
]);

export const arcRuntimeRollbackOutcomeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("rolled-back"), from: z.string(), to: z.string() })
    .strict(),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }).strict(),
  z.object({ kind: z.literal("failed"), reason: z.string() }).strict(),
]);

export const arcRpcContract = defineRpcContract({
  "arc.status": {
    input: z.null(),
    output: arcStatusSchema,
  },
  "arc.agents.list": {
    input: z.null(),
    output: z.object({ agents: z.array(arcAgentStatusSchema) }).strict(),
  },
  "arc.agents.get": {
    input: z.object({ id: arcAgentIdSchema }).strict(),
    output: z.object({ agent: arcAgentStatusSchema }).strict(),
  },
  "arc.agents.prepare": {
    input: z.object({ id: arcAgentIdSchema }).strict(),
    output: z.object({ agent: arcAgentStatusSchema }).strict(),
  },
  "arc.agents.repair": {
    input: z.object({ id: arcAgentIdSchema }).strict(),
    output: z.object({ agent: arcAgentStatusSchema }).strict(),
  },
  "arc.agents.checkForUpdate": {
    input: z.object({ id: arcAgentIdSchema }).strict(),
    output: z
      .object({ discovery: arcRuntimeUpdateDiscoverySchema })
      .strict(),
  },
  "arc.agents.update": {
    input: z.object({ id: arcAgentIdSchema }).strict(),
    output: z
      .object({
        outcome: arcRuntimeUpdateOutcomeSchema,
        agent: arcAgentStatusSchema,
      })
      .strict(),
  },
  "arc.agents.rollback": {
    input: z.object({ id: arcAgentIdSchema }).strict(),
    output: z
      .object({
        outcome: arcRuntimeRollbackOutcomeSchema,
        agent: arcAgentStatusSchema,
      })
      .strict(),
  },
  "arc.accounts.list": {
    input: z.null(),
    output: z
      .object({
        accounts: z.array(arcAccountSchema),
        sources: z.array(arcAccountSourceStatusSchema),
      })
      .strict(),
  },
  "arc.accounts.setEnabled": {
    input: z.object({ id: z.string(), enabled: z.boolean() }).strict(),
    output: z.object({ account: arcAccountSchema }).strict(),
  },
  "arc.accounts.remove": {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  "arc.accounts.reorder": {
    input: z.object({ family: z.string(), orderedIds: z.array(z.string()) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  "arc.login.openai.start": {
    input: z.null(),
    output: z.object({ challenge: arcAccountLoginChallengeSchema }).strict(),
  },
  "arc.login.openai.poll": {
    input: z.object({ sessionId: z.string() }).strict(),
    output: z
      .object({ poll: arcOpenAiLoginPollSchema, state: arcAccountLoginStateSchema })
      .strict(),
  },
  "arc.login.openai.cancel": {
    input: z.object({ sessionId: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  "arc.login.claude.start": {
    input: z.null(),
    output: z.object({ challenge: arcAccountLoginChallengeSchema }).strict(),
  },
  "arc.login.claude.complete": {
    input: z.object({ sessionId: z.string(), code: z.string() }).strict(),
    output: z.object({ account: arcAccountSchema }).strict(),
  },
  "arc.omp.providers": {
    input: z.null(),
    output: z.object({ providers: z.array(arcOmpProviderSchema) }).strict(),
  },
  "arc.omp.login.start": {
    input: z.object({ provider: z.string() }).strict(),
    output: z.object({ challenge: arcOmpLoginChallengeSchema }).strict(),
  },
  "arc.omp.login.poll": {
    input: z.object({ sessionId: z.string() }).strict(),
    output: z.object({ poll: arcOmpLoginPollSchema }).strict(),
  },
  "arc.omp.login.cancel": {
    input: z.object({ sessionId: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  "arc.omp.login.submitKey": {
    input: z.object({ sessionId: z.string(), key: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  "arc.usage.snapshot": {
    input: z.null(),
    output: arcUsageSnapshotSchema,
  },
  "arc.usage.current": {
    input: z
      .object({
        agentId: arcAgentIdSchema,
        activeAccountKey: z.string().nullable().optional(),
        // The thread's selected model id. For OMP this names the provider the
        // execution will run on ("<provider>/<model>"), which is the only
        // evidence Arc accepts for an unpinned OMP thread's active account.
        activeModelId: z.string().nullable().optional(),
      })
      .strict(),
    output: arcCurrentAgentUsageSchema,
  },
  "arc.usage.refresh": {
    input: z.object({ resourceId: z.string().optional() }).strict(),
    output: arcUsageSnapshotSchema,
  },
});
