// bb-plugin-adnan-mission-control — backend entry.
//
// Read-only observability + plugin-owned state, plus one deliberate-action
// surface (Phase 5, Quick Actions): thread_send/thread_stop/thread_delegate.
// Those three are the only calls that mutate a BB thread, and every one of
// them is fired by an explicit button click in the panel — never an agent
// tool, never a timer. Delegate additionally requires the "Delegate"
// Approval Center category to already be on. Everything else here is
// read-only. The mission state (workflow classification) write surface is:
//   - the report_mission_state agent tool        -> provenance "agent-reported"
//   - the `bb mission-control set` CLI           -> provenance "agent-reported"
//     (or "user-confirmed" with --as-user)
//   - the plugin UI                              -> provenance "user-confirmed"
// Everything rendered from BB thread/environment/event data is labeled
// "bb-observed".
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared contract (app.tsx imports only the type of rpcContract)
// ---------------------------------------------------------------------------

const provenanceSchema = z.enum(["bb-observed", "agent-reported", "user-confirmed"]);
export type Provenance = z.infer<typeof provenanceSchema>;

// Evidence (Phase 4): a real observed command execution, not an agent claim.
// Attached to a verification item only by a deliberate user action.
const verificationEvidenceSchema = z.object({
  threadId: z.string(),
  threadTitle: z.string(),
  command: z.string().max(400),
  exitCode: z.number().nullable(),
  itemStatus: z.string().max(20),
  completedAt: z.number(),
});
export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>;

const missionValuesSchema = z.object({
  task: z.string().max(300).nullable(),
  intent: z.string().max(40).nullable(),
  domains: z.array(z.string().max(40)).max(8),
  concerns: z.array(z.string().max(40)).max(8),
  risk: z.enum(["low", "normal", "high"]).nullable(),
  phase: z.string().max(60).nullable(),
  activeSkills: z.array(z.string().max(80)).max(12),
  verification: z
    .array(
      z.object({
        label: z.string().max(80),
        status: z.enum(["pending", "passed", "failed", "not-required"]),
        evidence: verificationEvidenceSchema.nullable().optional(),
        risk: z.string().max(200).nullable().optional(),
      }),
    )
    .max(12),
  approvalScope: z
    .object({
      phase: z.string().max(80).nullable(),
      allowed: z.array(z.string().max(60)).max(12),
      blocked: z.array(z.string().max(60)).max(12),
    })
    .nullable(),
});
export type MissionValues = z.infer<typeof missionValuesSchema>;

const missionFields = Object.keys(missionValuesSchema.shape) as (keyof MissionValues)[];

const missionStateSchema = z.object({
  values: missionValuesSchema,
  fieldProvenance: z.record(z.string(), provenanceSchema),
  updatedAt: z.number(),
  updatedBy: z.enum(["agent-tool", "cli", "ui"]),
});
export type MissionState = z.infer<typeof missionStateSchema>;

const emptyMissionValues = (): MissionValues => ({
  task: null,
  intent: null,
  domains: [],
  concerns: [],
  risk: null,
  phase: null,
  activeSkills: [],
  verification: [],
  approvalScope: null,
});

const tokenCountSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
  cachedInputTokens: z.number(),
  totalTokens: z.number(),
});

const enrichedThreadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  titleFallback: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  visibility: z.string(),
  status: z.string(),
  runtimeDisplayStatus: z.string().nullable(),
  providerId: z.string(),
  hasPendingInteraction: z.boolean(),
  pendingCount: z.number(),
  pendingTitles: z.array(z.string()).max(4),
  createdAt: z.number(),
  updatedAt: z.number(),
  environment: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      branchName: z.string().nullable(),
      path: z.string().nullable(),
      isWorktree: z.boolean().nullable(),
      hostId: z.string().nullable(),
    })
    .nullable(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  permissionMode: z.string().nullable(),
  usage: z
    .object({
      last: tokenCountSchema.nullable(),
      total: tokenCountSchema.nullable(),
      modelContextWindow: z.number().nullable(),
    })
    .nullable(),
  context: z
    .object({
      estimated: z.boolean(),
      usedTokens: z.number().nullable(),
      modelContextWindow: z.number().nullable(),
    })
    .nullable(),
  lastAction: z.string().nullable(),
  childCount: z.number(),
  provenance: z.literal("bb-observed"),
  accountKey: z.string().nullable(),
  accountLabel: z.string().nullable(),
});
export type EnrichedThread = z.infer<typeof enrichedThreadSchema>;

const probeProviderSchema = z.object({
  providerId: z.string(),
  threadsSampled: z.number(),
  modelEvents: z.number(),
  tokenUsageEvents: z.number(),
  contextUsageEvents: z.number(),
  fileChangeEvents: z.number(),
  pendingInteractions: z.number(),
  /** Event type -> times seen, across sampled threads. Discovery, not assumption. */
  eventTypes: z.record(z.string(), z.number()),
});
export type ProbeProvider = z.infer<typeof probeProviderSchema>;

const probeSchema = z.object({
  at: z.number().nullable(),
  providers: z.array(probeProviderSchema),
});
export type Probe = z.infer<typeof probeSchema>;

// -- Role router (Phase 2) ---------------------------------------------------
//
// A role is a stable name (PLAN, REVIEW, ...) mapped to a live
// provider/model/reasoning tuple. Mappings are plugin-owned state; the
// catalog is read live from bb.sdk.providers and never hardcoded.

const reasoningLevelSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);
const permissionModeSchema = z.enum(["accept-edits", "auto", "full"]);

const roleMappingSchema = z.object({
  /** Stable slug, unique within the mapping list. */
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(40),
  providerId: z.string().max(80).nullable(),
  /** Catalog model id (SystemExecutionOptionsResponse.models[].id). */
  model: z.string().max(160).nullable(),
  reasoningLevel: reasoningLevelSchema.nullable(),
  serviceTier: z.string().max(40).nullable(),
  /** null = provider default, same convention as reasoningLevel/serviceTier.
   *  Defaulted (not required) so mappings saved before this field existed
   *  still parse from KV. */
  permissionMode: permissionModeSchema.nullable().default(null),
});
export type RoleMapping = z.infer<typeof roleMappingSchema>;

const roleMappingsStateSchema = z.object({
  roles: z.array(roleMappingSchema).max(24),
  updatedAt: z.number(),
  updatedBy: z.enum(["ui", "cli"]),
});
export type RoleMappingsState = z.infer<typeof roleMappingsStateSchema>;

const catalogModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  model: z.string(),
  isDefault: z.boolean(),
  defaultReasoningEffort: z.string().nullable(),
  supportedReasoningEfforts: z.array(z.string()),
  /** Owning provider when the catalog declares it; null = not attributed. */
  routeProviderId: z.string().nullable(),
});

const catalogProviderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  available: z.boolean(),
  pluginId: z.string().nullable(),
  family: z.string().nullable(),
  modelCatalogScope: z.enum(["host", "workspace"]).nullable(),
  supportsServiceTier: z.boolean(),
  reasoningLevels: z.array(z.object({ id: z.string(), label: z.string() })),
  serviceTiers: z.array(z.object({ id: z.string(), label: z.string() })),
  /** From providers.list()[].capabilities.permissionModes; empty = unreported. */
  permissionModes: z.array(permissionModeSchema),
});

const roleCatalogSchema = z.object({
  at: z.number().nullable(),
  loadError: z.string().nullable(),
  providers: z.array(catalogProviderSchema),
  models: z.array(catalogModelSchema),
});
export type RoleCatalog = z.infer<typeof roleCatalogSchema>;

const roleIssueSchema = z.object({
  roleId: z.string(),
  kind: z.enum([
    "provider-missing",
    "provider-unavailable",
    "model-missing",
    "reasoning-unsupported",
    "permission-mode-unsupported",
  ]),
  message: z.string(),
});
export type RoleIssue = z.infer<typeof roleIssueSchema>;

// -- Approval Center (Phase 3) -----------------------------------------------
//
// Fixed permission taxonomy. This is a distinct control from the freeform
// approvalScope.allowed/blocked text on mission state (which is an agent's
// per-phase note) — these categories are only ever set by a deliberate user
// toggle (UI or CLI). No agent tool writes this state. Unset/new categories
// default to false ("not approved"): nothing is granted automatically.

const APPROVAL_CATEGORIES = [
  { id: "read", label: "Read" },
  { id: "investigate", label: "Investigate" },
  { id: "edit", label: "Edit" },
  { id: "execute", label: "Execute / Test" },
  { id: "install", label: "Install" },
  { id: "delegate", label: "Delegate" },
  { id: "commit", label: "Commit" },
  { id: "push", label: "Push" },
  { id: "merge", label: "Merge" },
  { id: "deploy", label: "Deploy" },
  { id: "db-write", label: "Database write" },
] as const;
export type ApprovalCategoryId = (typeof APPROVAL_CATEGORIES)[number]["id"];
const APPROVAL_CATEGORY_IDS: readonly string[] = APPROVAL_CATEGORIES.map((c) => c.id);

const approvalsStateSchema = z.object({
  approvals: z.record(z.string(), z.boolean()),
  updatedAt: z.number(),
  updatedBy: z.enum(["ui", "cli"]),
});
export type ApprovalsState = z.infer<typeof approvalsStateSchema>;

function defaultApprovals(): ApprovalsState {
  return {
    approvals: Object.fromEntries(APPROVAL_CATEGORIES.map((c) => [c.id, false])),
    updatedAt: 0,
    updatedBy: "ui",
  };
}

// -- Verification Guardian (Phase 4) -----------------------------------------
//
// Domain presets (Code/Kafka/Web checklist labels) live client-side in
// components/verification.tsx — pure UI convenience, no server state. The
// checklist itself is the existing Phase 1 mission.values.verification
// field. Evidence is bb-observed (real command-execution events) and only
// ever attached to an item by a deliberate user click — never inferred or
// written by an agent tool.

const countersSchema = z.object({
  total: z.number(),
  active: z.number(),
  idle: z.number(),
  other: z.number(),
  pendingInteractions: z.number(),
  providersInUse: z.array(z.string()),
  generatedAt: z.number(),
});

// -- Arc Core proxy (Phase 10) ------------------------------------------------
//
// The Arc product backend is a separate bundled plugin (arc-core). Mission
// Control proxies its fixed, zod-validated methods over loopback HTTP so the
// renderer only ever calls this plugin. Outputs are passed through
// unvalidated (arc-core already enforces its own strict schemas); the
// frontend types them via the plain interfaces in lib/arc-types.ts.

/** arc_status output — the one Arc method with a local, first-class shape:
 *  an unavailable Arc host degrades to `{ arcAvailable:false }` instead of
 *  erroring the whole panel. */
const arcStatusSchema = z.object({
  arcAvailable: z.boolean(),
  reason: z.string().nullable(),
});
export type ArcStatus = z.infer<typeof arcStatusSchema>;

export const rpcContract = defineRpcContract({
  mission_get: {
    input: z.null(),
    output: z.object({ state: missionStateSchema.nullable() }),
  },
  mission_set: {
    input: z.object({ values: missionValuesSchema.partial() }),
    output: z.object({ state: missionStateSchema }),
  },
  tree_get: {
    input: z.object({ includeArchived: z.boolean().default(false) }),
    output: z.object({
      counters: countersSchema,
      threads: z.array(enrichedThreadSchema),
      probe: probeSchema,
    }),
  },
  probe_run: {
    input: z.null(),
    output: z.object({ probe: probeSchema }),
  },
  roles_get: {
    input: z.object({ refresh: z.boolean().default(false) }),
    output: z.object({
      state: roleMappingsStateSchema,
      catalog: roleCatalogSchema,
      issues: z.array(roleIssueSchema),
    }),
  },
  roles_save: {
    input: z.object({ roles: z.array(roleMappingSchema).max(24) }),
    output: z.object({
      state: roleMappingsStateSchema,
      issues: z.array(roleIssueSchema),
    }),
  },
  approvals_get: {
    input: z.null(),
    output: z.object({
      categories: z.array(z.object({ id: z.string(), label: z.string() })),
      state: approvalsStateSchema,
    }),
  },
  approvals_set: {
    input: z.object({ approvals: z.record(z.string(), z.boolean()) }),
    output: z.object({ state: approvalsStateSchema }),
  },
  evidence_get: {
    input: z.null(),
    output: z.object({ at: z.number().nullable(), evidence: z.array(verificationEvidenceSchema) }),
  },
  verification_attach_evidence: {
    input: z.object({ label: z.string().max(80), evidence: verificationEvidenceSchema }),
    output: z.object({ state: missionStateSchema }),
  },
  verification_clear_evidence: {
    input: z.object({ label: z.string().max(80) }),
    output: z.object({ state: missionStateSchema }),
  },
  thread_send: {
    input: z.object({
      threadId: z.string(),
      text: z.string().min(1).max(4000),
      mode: z.enum(["queue-if-active", "steer-if-active"]),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  thread_stop: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  thread_delegate: {
    input: z.object({ threadId: z.string(), roleId: z.string(), prompt: z.string().min(1).max(4000) }),
    output: z.object({ childThreadId: z.string() }),
  },
  // Arc proxy surface (Phase 10). Inputs are validated here; outputs are
  // passed through unvalidated (typed by the frontend via lib/arc-types.ts).
  arc_status: { input: z.null(), output: arcStatusSchema },
  arc_agents_list: { input: z.null(), output: z.unknown() },
  arc_agents_prepare: { input: z.object({ id: z.string() }), output: z.unknown() },
  arc_agents_repair: { input: z.object({ id: z.string() }), output: z.unknown() },
  arc_agents_check_for_update: { input: z.object({ id: z.string() }), output: z.unknown() },
  arc_agents_update: { input: z.object({ id: z.string() }), output: z.unknown() },
  arc_agents_rollback: { input: z.object({ id: z.string() }), output: z.unknown() },
  arc_accounts_list: { input: z.null(), output: z.unknown() },
  arc_accounts_set_enabled: { input: z.object({ id: z.string(), enabled: z.boolean() }), output: z.unknown() },
  arc_accounts_remove: { input: z.object({ id: z.string() }), output: z.unknown() },
  arc_accounts_reorder: {
    input: z.object({ family: z.string(), orderedIds: z.array(z.string()) }),
    output: z.unknown(),
  },
  arc_login_openai_start: { input: z.null(), output: z.unknown() },
  arc_login_openai_poll: { input: z.object({ sessionId: z.string() }), output: z.unknown() },
  arc_login_openai_cancel: { input: z.object({ sessionId: z.string() }), output: z.unknown() },
  arc_login_claude_start: { input: z.null(), output: z.unknown() },
  arc_login_claude_complete: { input: z.object({ sessionId: z.string(), code: z.string() }), output: z.unknown() },
  arc_omp_providers: { input: z.null(), output: z.unknown() },
  arc_omp_login_start: { input: z.object({ provider: z.string() }), output: z.unknown() },
  arc_omp_login_poll: { input: z.object({ sessionId: z.string() }), output: z.unknown() },
  arc_omp_login_cancel: { input: z.object({ sessionId: z.string() }), output: z.unknown() },
  arc_omp_login_submit_key: { input: z.object({ sessionId: z.string(), key: z.string() }), output: z.unknown() },
  arc_usage_snapshot: { input: z.null(), output: z.unknown() },
  arc_usage_refresh: { input: z.object({ resourceId: z.string().optional() }), output: z.unknown() },
});

/** Realtime channel the app listens on; payload is an invalidation hint. */
const MC_CHANGED = "mc-changed";

const KV_MISSION = "mission-state";
const KV_PROBE = "capability-probe";
const KV_ROLES = "role-mappings";
const KV_APPROVALS = "approval-center";

/** Seed roles: stable conceptual names only — no provider/model hardcoded. */
const DEFAULT_ROLES: Array<Pick<RoleMapping, "id" | "label">> = [
  { id: "plan", label: "PLAN" },
  { id: "task", label: "TASK" },
  { id: "advisor", label: "ADVISOR" },
  { id: "architect", label: "ARCHITECT" },
  { id: "designer", label: "DESIGNER" },
  { id: "review", label: "REVIEW" },
  { id: "commit", label: "COMMIT" },
  { id: "slow", label: "SLOW" },
  { id: "smol", label: "SMOL" },
];

function seedRoles(): RoleMappingsState {
  return {
    roles: DEFAULT_ROLES.map((role) => ({
      ...role,
      providerId: null,
      model: null,
      reasoningLevel: null,
      serviceTier: null,
      permissionMode: null,
    })),
    updatedAt: Date.now(),
    updatedBy: "ui",
  };
}

// ---------------------------------------------------------------------------
// Backend helpers
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  return typeof value === "object" && value !== null ? (value as AnyRecord) : null;
}

function eventTypeOf(event: unknown): string {
  const record = asRecord(event);
  return typeof record?.type === "string" ? record.type : "";
}

/** Map the newest "meaningful" thread event to a short human label. */
function lastActionFrom(events: unknown[]): string | null {
  const NOISE: Record<string, true> = {
    "thread/tokenUsage/updated": true,
    "thread/contextWindowUsage/updated": true,
    "thread/context/cleared": true,
    "item/reasoning/textDelta": true,
    "item/reasoning/summaryTextDelta": true,
    "item/agentMessage/delta": true,
    "provider/rateLimits/updated": true,
  };
  const LABELS: Array<[prefix: string, label: string]> = [
    ["item/fileChange/outputDelta", "Editing files"],
    ["item/toolCall/", "Running tool"],
    ["item/commandExecution/", "Running command"],
    ["item/delegation/", "Delegating"],
    ["item/mcpToolCall/", "Calling MCP tool"],
    ["item/plan/", "Planning"],
    ["item/backgroundTask/", "Background task"],
    ["provider/modelFallback", "Model fallback"],
    ["provider/error", "Provider error"],
    ["system/error", "System error"],
    ["provider/warning", "Provider warning"],
  ];
  for (const event of events) {
    const type = eventTypeOf(event);
    if (type === "" || NOISE[type] === true || type.startsWith("client/")) continue;
    const match = LABELS.find(([prefix]) => type.startsWith(prefix));
    return match ? match[1] : "Working";
  }
  return null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// -- Arc proxy helpers ---------------------------------------------------------

/** Raised when arc-core reports the server was not started by the Arc app.
 *  Carries a clean, user-facing message; arc_status catches it and degrades
 *  to `{ arcAvailable:false }` while every other method lets it propagate. */
class ArcUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason || "Arc services are unavailable on this server.");
    this.name = "ArcUnavailableError";
  }
}

const ARC_UNAVAILABLE_PREFIX = "arc-unavailable";

/** The plugin RPC HTTP layer returns errors as `{ ok:false, error: string |
 *  { code, message } }`. Extract the human message from either shape. */
function arcErrorMessage(payload: AnyRecord): string | null {
  const error = payload.error;
  if (typeof error === "string") return error;
  const record = asRecord(error);
  if (record === null) return null;
  return str(record.message) ?? str(record.code) ?? null;
}

/** Strips the "arc-unavailable: " prefix off an arc-core error message. */
function arcUnavailableReason(message: string): string | null {
  if (!message.startsWith(ARC_UNAVAILABLE_PREFIX)) return null;
  const rest = message.slice(ARC_UNAVAILABLE_PREFIX.length).trim();
  return rest.length > 0 ? rest : null;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded (phase 10: arc agents, accounts, usage & limits)");

  // -- Mission state --------------------------------------------------------

  async function readMission(): Promise<MissionState | null> {
    const raw = await bb.storage.kv.get<MissionState>(KV_MISSION);
    if (raw == null) return null;
    const parsed = missionStateSchema.safeParse(raw);
    if (!parsed.success) {
      bb.log.warn(`ignoring malformed stored mission state: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      return null;
    }
    return parsed.data;
  }

  async function writeMission(
    patch: Partial<MissionValues>,
    provenance: Exclude<Provenance, "bb-observed">,
    updatedBy: MissionState["updatedBy"],
  ): Promise<MissionState> {
    const current = (await readMission()) ?? {
      values: emptyMissionValues(),
      fieldProvenance: {},
      updatedAt: 0,
      updatedBy,
    };
    const fieldProvenance: Record<string, Provenance> = { ...current.fieldProvenance };
    for (const field of missionFields) {
      if (field in patch) fieldProvenance[field] = provenance;
    }
    const next: MissionState = {
      values: { ...current.values, ...patch },
      fieldProvenance,
      updatedAt: Date.now(),
      updatedBy,
    };
    await bb.storage.kv.set(KV_MISSION, next);
    publishChange("mission");
    return next;
  }

  // -- Role router state (plugin-owned) ---------------------------------------

  async function readRoles(): Promise<RoleMappingsState> {
    const raw = await bb.storage.kv.get<RoleMappingsState>(KV_ROLES);
    if (raw == null) return seedRoles();
    const parsed = roleMappingsStateSchema.safeParse(raw);
    if (!parsed.success) {
      bb.log.warn(`ignoring malformed stored role mappings: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      return seedRoles();
    }
    return parsed.data;
  }

  let catalogCache: { at: number; data: RoleCatalog } | null = null;

  /** Live provider/model catalog from bb.sdk.providers, cached 60s; stale
   *  data is served on refresh failure rather than erroring the UI.
   *
   *  bb.sdk.providers.models() with no providerId returns models scoped to
   *  one selected/default provider only (SystemExecutionOptionsResponse is
   *  inherently single-provider-context) — it does NOT aggregate every
   *  registered provider's catalog. Calling it once, as before, silently
   *  reduced the whole role router to whichever provider is "current"
   *  (observed: Codex), which is the actual root cause of role mappings for
   *  Claude Code / acp-omp / any non-default provider showing as
   *  "model-missing" even though they resolve fine in BB's own picker. Fix:
   *  query per available provider and merge. */
  async function fetchCatalog(): Promise<RoleCatalog> {
    if (catalogCache !== null && Date.now() - catalogCache.at < 60_000) return catalogCache.data;
    try {
      const providerRows = await bb.sdk.providers.list();
      const providersRaw = Array.isArray(providerRows) ? providerRows.map(asRecord) : [];

      const providers: RoleCatalog["providers"] = [];
      for (const row of providersRaw) {
        if (row === null) continue;
        const capabilities = asRecord(row.capabilities);
        const permissionModes = Array.isArray(capabilities?.permissionModes)
          ? capabilities.permissionModes
              .map((mode) => permissionModeSchema.safeParse(mode))
              .filter((parsed): parsed is { success: true; data: z.infer<typeof permissionModeSchema> } => parsed.success)
              .map((parsed) => parsed.data)
          : [];
        const toOptions = (value: unknown) =>
          Array.isArray(value)
            ? value
                .map(asRecord)
                .filter((entry): entry is AnyRecord => entry !== null)
                .map((entry) => ({ id: String(entry.id ?? ""), label: String(entry.label ?? entry.id ?? "") }))
                .filter((entry) => entry.id !== "")
            : [];
        const parsedProvider = catalogProviderSchema.safeParse({
          id: str(row.id),
          displayName: str(row.displayName) ?? str(row.id) ?? "unknown",
          available: row.available === true,
          pluginId: str(row.pluginId),
          family: str(row.family),
          modelCatalogScope: str(capabilities?.modelCatalogScope) === "workspace" ? "workspace" : "host",
          supportsServiceTier: asRecord(capabilities)?.supportsServiceTier === true,
          reasoningLevels: toOptions(row.reasoningLevels),
          serviceTiers: toOptions(row.serviceTiers),
          permissionModes,
        });
        if (parsedProvider.success) providers.push(parsedProvider.data);
      }

      const modelResults = await Promise.all(
        providers
          .filter((provider) => provider.available)
          .map(async (provider) => {
            try {
              return { providerId: provider.id, options: await bb.sdk.providers.models({ providerId: provider.id }) };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              bb.log.warn(`model catalog fetch failed for ${provider.id}: ${message}`);
              return { providerId: provider.id, options: null };
            }
          }),
      );

      const models: RoleCatalog["models"] = [];
      const seenModelIds = new Set<string>();
      // A provider registered in BB but not actually usable here (missing
      // executable, auth, etc.) reports success at providers.list() and only
      // fails when its models are fetched. Auto-detect that and drop it from
      // the catalog entirely, the same way a CLI only lists backends it can
      // actually reach, instead of surfacing a permanent warning for
      // something the user never intends to configure.
      const unusableProviderIds = new Set<string>();
      for (const { providerId, options } of modelResults) {
        const optionsRecord = asRecord(options);
        if (optionsRecord === null || asRecord(optionsRecord.modelLoadError) !== null) {
          unusableProviderIds.add(providerId);
          continue;
        }
        const modelsRaw = Array.isArray(optionsRecord.models) ? optionsRecord.models.map(asRecord) : [];
        for (const row of modelsRaw) {
          if (row === null) continue;
          const efforts = Array.isArray(row.supportedReasoningEfforts)
            ? row.supportedReasoningEfforts
                .map((effort) => str(asRecord(effort)?.reasoningEffort))
                .filter((effort): effort is string => effort !== null)
            : [];
          const parsedModel = catalogModelSchema.safeParse({
            id: str(row.id),
            displayName: str(row.displayName) ?? str(row.id) ?? "unknown",
            model: str(row.model) ?? "",
            isDefault: row.isDefault === true,
            defaultReasoningEffort: str(row.defaultReasoningEffort),
            supportedReasoningEfforts: efforts,
            // Per-provider query: attribute to the provider we queried when
            // the row itself doesn't declare an owner.
            routeProviderId: str(row.routeProviderId) ?? providerId,
          });
          // A model id can repeat across providers that share a catalog
          // scope; keep the first (provider-attributed) occurrence.
          if (parsedModel.success && !seenModelIds.has(`${parsedModel.data.routeProviderId}:${parsedModel.data.id}`)) {
            seenModelIds.add(`${parsedModel.data.routeProviderId}:${parsedModel.data.id}`);
            models.push(parsedModel.data);
          }
        }
      }

      const fetchedAt = Date.now();
      const data: RoleCatalog = {
        at: fetchedAt,
        loadError: null,
        providers: providers.filter((provider) => !unusableProviderIds.has(provider.id)),
        models,
      };
      catalogCache = { at: fetchedAt, data };
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bb.log.warn(`provider catalog fetch failed: ${message}`);
      if (catalogCache !== null) return catalogCache.data;
      return { at: null, loadError: message, providers: [], models: [] };
    }
  }

  /** Proxy one arc-core RPC over loopback HTTP, mirroring the account-pool
   *  pattern. Transport failures and non-arc errors surface as descriptive
   *  Errors; an "arc-unavailable" error surfaces as ArcUnavailableError so
   *  arc_status can degrade gracefully while other methods propagate it. */
  async function proxyArc(method: string, input: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${bb.server.loopbackBaseUrl}/api/v1/plugins/arc-core/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input ?? null),
      });
    } catch (error) {
      throw new Error(`Arc Core is unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`Arc Core request failed (HTTP ${response.status}).`);
    }
    let payload: AnyRecord | null = null;
    try {
      payload = asRecord(await response.json());
    } catch {
      throw new Error("Arc Core returned a non-JSON response.");
    }
    if (payload === null) throw new Error("Arc Core returned an invalid response.");
    if (payload.ok === true) return payload.result;
    const raw = arcErrorMessage(payload) ?? "Arc Core request failed.";
    const unavailableReason = arcUnavailableReason(raw);
    if (unavailableReason !== null) throw new ArcUnavailableError(unavailableReason);
    throw new Error(raw);
  }

  /** Advisory checks: a mapping pointing at an unavailable provider or a
   *  withdrawn model renders with a warning, it is not blocked. */
  function computeRoleIssues(roles: RoleMapping[], catalog: RoleCatalog): RoleIssue[] {
    const issues: RoleIssue[] = [];
    for (const role of roles) {
      if (role.providerId === null) continue;
      const provider = catalog.providers.find((candidate) => candidate.id === role.providerId);
      if (provider === undefined) {
        issues.push({
          roleId: role.id,
          kind: "provider-missing",
          message: `Provider "${role.providerId}" is not registered in BB.`,
        });
        continue;
      }
      if (!provider.available) {
        issues.push({
          roleId: role.id,
          kind: "provider-unavailable",
          message: `Provider "${provider.displayName}" is registered but unavailable.`,
        });
      }
      if (
        role.permissionMode !== null &&
        provider.permissionModes.length > 0 &&
        !provider.permissionModes.includes(role.permissionMode)
      ) {
        issues.push({
          roleId: role.id,
          kind: "permission-mode-unsupported",
          message: `Provider "${provider.displayName}" does not support permission mode "${role.permissionMode}".`,
        });
      }
      if (role.model !== null) {
        const model = catalog.models.find(
          (candidate) =>
            candidate.id === role.model &&
            (candidate.routeProviderId === null || candidate.routeProviderId === role.providerId),
        );
        if (model === undefined) {
          issues.push({
            roleId: role.id,
            kind: "model-missing",
            message: `Model "${role.model}" is not in the current catalog for ${provider.displayName}.`,
          });
        } else if (
          role.reasoningLevel !== null &&
          model.supportedReasoningEfforts.length > 0 &&
          !model.supportedReasoningEfforts.includes(role.reasoningLevel)
        ) {
          issues.push({
            roleId: role.id,
            kind: "reasoning-unsupported",
            message: `Model "${model.displayName}" does not support reasoning "${role.reasoningLevel}".`,
          });
        }
      }
    }
    return issues;
  }

  // -- Approval Center state (Phase 3, plugin-owned, user-set only) -----------

  async function readApprovals(): Promise<ApprovalsState> {
    const raw = await bb.storage.kv.get<ApprovalsState>(KV_APPROVALS);
    if (raw == null) return defaultApprovals();
    const parsed = approvalsStateSchema.safeParse(raw);
    if (!parsed.success) {
      bb.log.warn(`ignoring malformed stored approvals: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      return defaultApprovals();
    }
    // New categories added since this state was stored still default to
    // false — never inherit approval from an unrelated older category.
    return { ...parsed.data, approvals: { ...defaultApprovals().approvals, ...parsed.data.approvals } };
  }

  async function writeApprovals(patch: Record<string, boolean>, updatedBy: ApprovalsState["updatedBy"]): Promise<ApprovalsState> {
    const current = await readApprovals();
    const approvals = { ...current.approvals };
    for (const [id, value] of Object.entries(patch)) {
      if (APPROVAL_CATEGORY_IDS.includes(id)) approvals[id] = value;
    }
    const next: ApprovalsState = { approvals, updatedAt: Date.now(), updatedBy };
    await bb.storage.kv.set(KV_APPROVALS, next);
    publishChange("approvals");
    return next;
  }

  // -- Thread enrichment (bb-observed) ---------------------------------------

  type Enrichment = Pick<
    EnrichedThread,
    "model" | "reasoningLevel" | "permissionMode" | "usage" | "context" | "lastAction" | "pendingCount" | "pendingTitles"
  >;

  const enrichmentCache = new Map<string, { at: number; ttlMs: number; data: Enrichment }>();

  function invalidateThread(threadId: string) {
    enrichmentCache.delete(threadId);
  }
  function invalidateAll() {
    enrichmentCache.clear();
  }

  async function enrichThread(thread: AnyRecord): Promise<Enrichment> {
    const threadId = String(thread.id);
    const displayStatus = str(asRecord(thread.runtime)?.displayStatus) ?? str(thread.status);
    const isLive = displayStatus === "active" || thread.hasPendingInteraction === true;
    const ttlMs = isLive ? 15_000 : 300_000;
    const cached = enrichmentCache.get(threadId);
    if (cached && Date.now() - cached.at < cached.ttlMs) return cached.data;

    const empty: Enrichment = {
      model: null,
      reasoningLevel: null,
      permissionMode: null,
      usage: null,
      context: null,
      lastAction: null,
      pendingCount: 0,
      pendingTitles: [],
    };

    try {
      const [turnStarts, usageEvents, contextEvents, actionEvents, interactions] =
        await Promise.all([
          bb.sdk.threads.events.list({
            threadId,
            types: ["client/turn/start"],
            order: "desc",
            limit: "1",
          }),
          bb.sdk.threads.events.list({
            threadId,
            types: ["thread/tokenUsage/updated"],
            order: "desc",
            limit: "1",
          }),
          bb.sdk.threads.events.list({
            threadId,
            types: ["thread/contextWindowUsage/updated"],
            order: "desc",
            limit: "1",
          }),
          bb.sdk.threads.events.list({
            threadId,
            types: [
              "item/fileChange/outputDelta",
              "item/toolCall/progress",
              "item/commandExecution/outputDelta",
              "item/delegation/completed",
              "item/delegation/progress",
              "item/mcpToolCall/progress",
              "item/plan/delta",
              "item/backgroundTask/completed",
              "item/backgroundTask/progress",
              "provider/modelFallback",
              "provider/error",
              "system/error",
            ],
            order: "desc",
            limit: "12",
          }),
          bb.sdk.threads.interactions.list({ threadId }),
        ]);

      const turn = asRecord(turnStarts[0]);
      const execution = asRecord(turn?.execution);

      const usageEvent = asRecord(usageEvents[0]);
      const tokenUsage = asRecord(usageEvent?.tokenUsage);
      const toCounts = (value: unknown) => {
        const record = asRecord(value);
        if (record === null) return null;
        return {
          inputTokens: num(record.inputTokens) ?? 0,
          outputTokens: num(record.outputTokens) ?? 0,
          reasoningOutputTokens: num(record.reasoningOutputTokens) ?? 0,
          cachedInputTokens: num(record.cachedInputTokens) ?? 0,
          totalTokens: num(record.totalTokens) ?? 0,
        };
      };

      const contextEvent = asRecord(contextEvents[0]);
      const contextWindowUsage = asRecord(contextEvent?.contextWindowUsage);
      let usedTokens: number | null = null;
      const snapshot = asRecord(contextWindowUsage?.snapshot);
      if (Array.isArray(snapshot?.categories)) {
        let sum = 0;
        let sawTokens = false;
        for (const category of snapshot.categories) {
          const entries = asRecord(category)?.entries;
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            const tokens = num(asRecord(entry)?.tokens);
            if (tokens !== null) {
              sum += tokens;
              sawTokens = true;
            }
          }
        }
        if (sawTokens) usedTokens = sum;
      }

      const pending = Array.isArray(interactions)
        ? interactions.filter((interaction) => asRecord(interaction)?.status === "pending")
        : [];
      const pendingTitles = pending
        .slice(0, 4)
        .map((interaction) => {
          const record = asRecord(interaction);
          const origin = asRecord(record?.origin);
          const payload = asRecord(record?.payload);
          return (
            str(payload?.title) ??
            (origin?.kind === "plugin" ? "Plugin request" : str(record?.providerId) ?? "Approval")
          );
        })
        .filter((title): title is string => title !== null);

      const data: Enrichment = {
        model: str(execution?.model),
        reasoningLevel: str(execution?.reasoningLevel),
        permissionMode: str(execution?.permissionMode),
        usage:
          tokenUsage === null
            ? null
            : {
                last: toCounts(tokenUsage.last),
                total: toCounts(tokenUsage.total),
                modelContextWindow: num(tokenUsage.modelContextWindow),
              },
        context:
          contextWindowUsage === null
            ? null
            : {
                estimated: contextWindowUsage.estimated !== false,
                usedTokens,
                modelContextWindow: num(contextWindowUsage.modelContextWindow),
              },
        lastAction: lastActionFrom(actionEvents),
        pendingCount: pending.length,
        pendingTitles,
      };
      enrichmentCache.set(threadId, { at: Date.now(), ttlMs, data });
      return data;
    } catch (error) {
      bb.log.warn(`enrichment failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      enrichmentCache.set(threadId, { at: Date.now(), ttlMs, data: empty });
      return empty;
    }
  }

  async function accountLabelsByKey(): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    try {
      const result = asRecord(await proxyArc("arc.accounts.list", null));
      const accounts = Array.isArray(result?.accounts) ? result.accounts : [];
      for (const entry of accounts) {
        const account = asRecord(entry);
        const key = str(account?.accountKey);
        const providerLabel = str(account?.providerLabel);
        if (key === null || providerLabel === null) continue;
        const planLabel = str(account?.planLabel);
        labels.set(key, planLabel !== null ? `${providerLabel} · ${planLabel}` : providerLabel);
      }
    } catch {
      // Arc Core unavailable: threads still list, accountLabel just stays
      // null and renders as "Account unknown" — never fabricated.
    }
    return labels;
  }

  async function buildTree(includeArchived: boolean): Promise<{
    counters: z.infer<typeof countersSchema>;
    threads: EnrichedThread[];
  }> {
    const listed = await bb.sdk.threads.list({
      archived: includeArchived,
      includeHidden: true,
      limit: 200,
    });
    const rows = (Array.isArray(listed) ? listed : []).map((row) => asRecord(row)).filter((row): row is AnyRecord => row !== null);
    const accountLabels = await accountLabelsByKey();

    const childCount = new Map<string, number>();
    for (const row of rows) {
      const parent = str(row.parentThreadId);
      if (parent !== null) childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
    }

    const threads: EnrichedThread[] = [];
    for (const row of rows) {
      const runtime = asRecord(row.runtime);
      const enrichment = await enrichThread(row);
      const rowId = str(row.environmentId);
      const parsed = enrichedThreadSchema.safeParse({
        id: String(row.id),
        projectId: String(row.projectId),
        title: str(row.title) ?? str(row.titleFallback) ?? String(row.id),
        titleFallback: str(row.titleFallback),
        parentThreadId: str(row.parentThreadId),
        visibility: str(row.visibility) ?? "visible",
        status: str(row.status) ?? "unknown",
        runtimeDisplayStatus: str(runtime?.displayStatus),
        providerId: str(row.providerId) ?? "unknown",
        hasPendingInteraction: row.hasPendingInteraction === true,
        createdAt: num(row.createdAt) ?? 0,
        updatedAt: num(row.updatedAt) ?? 0,
        environment:
          rowId === null
            ? null
            : {
                id: rowId,
                name: str(row.environmentName),
                branchName: str(row.environmentBranchName),
                path: str(row.environmentPath),
                isWorktree: typeof row.environmentIsWorktree === "boolean" ? row.environmentIsWorktree : null,
                hostId: str(row.environmentHostId),
              },
        childCount: childCount.get(String(row.id)) ?? 0,
        provenance: "bb-observed",
        accountKey: str(row.accountKey),
        accountLabel:
          str(row.accountKey) !== null
            ? (accountLabels.get(str(row.accountKey) as string) ?? null)
            : null,
        ...enrichment,
      });
      if (parsed.success) threads.push(parsed.data);
    }

    const active = threads.filter((t) => t.runtimeDisplayStatus === "active" || t.status === "active").length;
    const idle = threads.filter((t) => t.runtimeDisplayStatus === "idle" || t.status === "idle").length;
    const providersInUse = Array.from(new Set(threads.map((t) => t.providerId))).sort();
    const pendingInteractions = threads.reduce((sum, t) => sum + t.pendingCount, 0);
    return {
      counters: {
        total: threads.length,
        active,
        idle,
        other: threads.length - active - idle,
        pendingInteractions,
        providersInUse,
        generatedAt: Date.now(),
      },
      threads,
    };
  }

  // -- Verification evidence (Phase 4, bb-observed) --------------------------

  let evidenceCache: { at: number; data: VerificationEvidence[] } | null = null;

  /** Real command executions from recently active threads — the evidence a
   *  user can attach to a verification item. Never inferred pass/fail here;
   *  exitCode is reported as observed and the UI leaves judgment to the user. */
  async function fetchCommandEvidence(): Promise<VerificationEvidence[]> {
    if (evidenceCache !== null && Date.now() - evidenceCache.at < 15_000) return evidenceCache.data;
    const listed = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 200 });
    const rows = (Array.isArray(listed) ? listed : []).map((row) => asRecord(row)).filter((row): row is AnyRecord => row !== null);
    const recent = [...rows].sort((a, b) => (num(b.updatedAt) ?? 0) - (num(a.updatedAt) ?? 0)).slice(0, 30);

    const evidence: VerificationEvidence[] = [];
    for (const row of recent) {
      const threadId = String(row.id);
      const threadTitle = str(row.title) ?? str(row.titleFallback) ?? threadId;
      try {
        const events = await bb.sdk.threads.events.list({
          threadId,
          types: ["item/completed"],
          order: "desc",
          limit: "20",
        });
        for (const event of events) {
          const item = asRecord(asRecord(event)?.item);
          if (item === null || item.type !== "commandExecution") continue;
          const command = str(item.command);
          const status = str(item.status);
          if (command === null || status === null || status === "pending") continue;
          evidence.push({
            threadId,
            threadTitle,
            command,
            exitCode: num(item.exitCode),
            itemStatus: status,
            completedAt: num(row.updatedAt) ?? Date.now(),
          });
        }
      } catch (error) {
        bb.log.warn(`evidence scan failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    evidence.sort((a, b) => b.completedAt - a.completedAt);
    const data = evidence.slice(0, 60);
    evidenceCache = { at: Date.now(), data };
    return data;
  }

  async function setVerificationEvidence(label: string, evidence: VerificationEvidence | null): Promise<MissionState> {
    const current = (await readMission()) ?? { values: emptyMissionValues(), fieldProvenance: {}, updatedAt: 0, updatedBy: "ui" as const };
    const verification = current.values.verification.map((item) => {
      if (item.label !== label) return item;
      if (evidence === null) return { ...item, evidence: null };
      return { ...item, evidence, status: evidence.exitCode === 0 ? ("passed" as const) : ("failed" as const) };
    });
    return writeMission({ verification }, "user-confirmed", "ui");
  }

  // -- Capability probe -------------------------------------------------------

  async function runProbe(): Promise<Probe> {
    const listed = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 200 });
    const rows = (Array.isArray(listed) ? listed : []).map((row) => asRecord(row)).filter((row): row is AnyRecord => row !== null);
    const byProvider = new Map<string, AnyRecord[]>();
    for (const row of rows) {
      const provider = str(row.providerId) ?? "unknown";
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider)!.push(row);
    }

    const providers: ProbeProvider[] = [];
    for (const [providerId, providerThreads] of Array.from(byProvider.entries()).sort()) {
      // Sample up to 2 most recently updated threads per provider.
      const sample = [...providerThreads]
        .sort((a, b) => (num(b.updatedAt) ?? 0) - (num(a.updatedAt) ?? 0))
        .slice(0, 2);
      const aggregate = {
        providerId,
        threadsSampled: sample.length,
        modelEvents: 0,
        tokenUsageEvents: 0,
        contextUsageEvents: 0,
        fileChangeEvents: 0,
        pendingInteractions: 0,
        eventTypes: {} as Record<string, number>,
      };
      for (const row of sample) {
        const threadId = String(row.id);
        try {
          // Scan the newest events without a type filter: record what the
          // provider actually emits instead of guessing type names.
          const [events, interactions] = await Promise.all([
            bb.sdk.threads.events.list({ threadId, order: "desc", limit: "100" }),
            bb.sdk.threads.interactions.list({ threadId }),
          ]);
          let sawModel = false;
          let sawUsage = false;
          let sawContext = false;
          let sawFileChange = false;
          for (const event of events) {
            const record = asRecord(event);
            const type = eventTypeOf(event);
            if (type === "") continue;
            aggregate.eventTypes[type] = (aggregate.eventTypes[type] ?? 0) + 1;
            if (str(asRecord(record?.execution)?.model) !== null) sawModel = true;
            if (type === "thread/tokenUsage/updated") sawUsage = true;
            if (type === "thread/contextWindowUsage/updated") sawContext = true;
            if (type.startsWith("item/fileChange/")) sawFileChange = true;
          }
          if (sawModel) aggregate.modelEvents += 1;
          if (sawUsage) aggregate.tokenUsageEvents += 1;
          if (sawContext) aggregate.contextUsageEvents += 1;
          if (sawFileChange) aggregate.fileChangeEvents += 1;
          if (
            Array.isArray(interactions) &&
            interactions.some((interaction) => asRecord(interaction)?.status === "pending")
          ) {
            aggregate.pendingInteractions += 1;
          }
        } catch (error) {
          bb.log.warn(`probe failed for ${providerId}/${threadId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      providers.push(aggregate);
    }

    const probe: Probe = { at: Date.now(), providers };
    await bb.storage.kv.set(KV_PROBE, probe);
    return probe;
  }

  async function readProbe(): Promise<Probe> {
    const cached = await bb.storage.kv.get<Probe>(KV_PROBE);
    if (cached != null) {
      const parsed = probeSchema.safeParse(cached);
      if (parsed.success) return parsed.data;
    }
    // Lazy first probe; if it fails, return an empty shell rather than erroring the UI.
    try {
      return await runProbe();
    } catch (error) {
      bb.log.warn(`initial probe failed: ${error instanceof Error ? error.message : String(error)}`);
      return { at: null, providers: [] };
    }
  }

  // -- Realtime invalidation --------------------------------------------------

  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  function publishChange(kind: "threads" | "mission" | "probe" | "roles" | "approvals") {
    if (publishTimer !== null) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      bb.realtime.publish(MC_CHANGED, { kind });
    }, 800);
    publishTimer.unref?.();
  }

  bb.events.on("experimental_thread.events", ({ thread }) => {
    invalidateThread(String(asRecord(thread)?.id ?? ""));
    publishChange("threads");
  });
  for (const name of ["thread.created", "thread.archived", "thread.unarchived", "thread.deleted"] as const) {
    bb.events.on(name, () => {
      invalidateAll();
      publishChange("threads");
    });
  }
  bb.events.on("interaction.pending", ({ thread }) => {
    invalidateThread(String(asRecord(thread)?.id ?? ""));
    publishChange("threads");
  });

  // -- RPC --------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    mission_get: async () => ({ state: await readMission() }),
    mission_set: async ({ values }) => {
      const state = await writeMission(values, "user-confirmed", "ui");
      return { state };
    },
    tree_get: async ({ includeArchived }) => {
      const [{ counters, threads }, probe] = await Promise.all([buildTree(includeArchived), readProbe()]);
      return { counters, threads, probe };
    },
    probe_run: async () => ({ probe: await runProbe() }),
    roles_get: async ({ refresh }) => {
      if (refresh) catalogCache = null;
      const [state, catalog] = await Promise.all([readRoles(), fetchCatalog()]);
      return { state, catalog, issues: computeRoleIssues(state.roles, catalog) };
    },
    roles_save: async ({ roles }) => {
      const ids = roles.map((role) => role.id);
      if (new Set(ids).size !== ids.length) throw new Error("roles_save: duplicate role ids");
      bb.log.info(
        `roles_save: [${roles
          .map((role) => `${role.id}${role.providerId !== null ? `=${role.providerId}/${role.model ?? "?"}` : ""}`)
          .join(", ")}]`,
      );
      const state: RoleMappingsState = { roles, updatedAt: Date.now(), updatedBy: "ui" };
      await bb.storage.kv.set(KV_ROLES, state);
      publishChange("roles");
      const catalog = await fetchCatalog();
      return { state, issues: computeRoleIssues(roles, catalog) };
    },
    approvals_get: async () => ({
      categories: APPROVAL_CATEGORIES.map((category) => ({ ...category })),
      state: await readApprovals(),
    }),
    approvals_set: async ({ approvals }) => ({ state: await writeApprovals(approvals, "ui") }),
    evidence_get: async () => ({ at: Date.now(), evidence: await fetchCommandEvidence() }),
    verification_attach_evidence: async ({ label, evidence }) => ({ state: await setVerificationEvidence(label, evidence) }),
    verification_clear_evidence: async ({ label }) => ({ state: await setVerificationEvidence(label, null) }),
    // Every one of these is fired by a deliberate button click in the panel
    // (Quick Actions, Phase 5) — never by an agent tool or on a timer.
    thread_send: async ({ threadId, text, mode }) => {
      await bb.sdk.threads.send({ threadId, mode, input: [{ type: "text", text, mentions: [] }] });
      return { ok: true as const };
    },
    thread_stop: async ({ threadId }) => {
      await bb.sdk.threads.stop({ threadId });
      return { ok: true as const };
    },
    thread_delegate: async ({ threadId, roleId, prompt }) => {
      const approvals = await readApprovals();
      if (approvals.approvals.delegate !== true) {
        throw new Error('Delegate is not approved. Turn on "Delegate" in the Approval Center first.');
      }
      const roles = await readRoles();
      const role = roles.roles.find((candidate) => candidate.id === roleId);
      if (role === undefined || role.providerId === null) {
        throw new Error(`Role "${roleId}" has no provider/model configured in Roles.`);
      }
      const parent = await bb.sdk.threads.get({ threadId });
      const parentRecord = asRecord(parent);
      if (parentRecord === null) throw new Error(`Thread "${threadId}" not found.`);
      const spawned = await bb.sdk.threads.spawn({
        projectId: String(parentRecord.projectId),
        parentThreadId: threadId,
        origin: "plugin",
        environment:
          str(parentRecord.environmentId) !== null
            ? { type: "reuse", environmentId: str(parentRecord.environmentId)! }
            : { type: "project-default" },
        providerId: role.providerId,
        model: role.model ?? undefined,
        reasoningLevel: role.reasoningLevel ?? undefined,
        serviceTier: role.serviceTier === "default" || role.serviceTier === "fast" ? role.serviceTier : undefined,
        prompt,
      });
      const childId = str(asRecord(spawned)?.id);
      if (childId === null) throw new Error("Delegate: BB did not return a new thread id.");
      return { childThreadId: childId };
    },
    // Arc proxy (Phase 10): every call here is a pass-through to arc-core.
    arc_status: async () => {
      try {
        await proxyArc("arc.status", null);
        return { arcAvailable: true, reason: null };
      } catch (error) {
        if (error instanceof ArcUnavailableError) {
          return { arcAvailable: false, reason: error.reason };
        }
        throw error;
      }
    },
    arc_agents_list: async () => proxyArc("arc.agents.list", null),
    arc_agents_prepare: async ({ id }) => proxyArc("arc.agents.prepare", { id }),
    arc_agents_repair: async ({ id }) => proxyArc("arc.agents.repair", { id }),
    arc_agents_check_for_update: async ({ id }) => proxyArc("arc.agents.checkForUpdate", { id }),
    arc_agents_update: async ({ id }) => proxyArc("arc.agents.update", { id }),
    arc_agents_rollback: async ({ id }) => proxyArc("arc.agents.rollback", { id }),
    arc_accounts_list: async () => proxyArc("arc.accounts.list", null),
    arc_accounts_set_enabled: async ({ id, enabled }) => proxyArc("arc.accounts.setEnabled", { id, enabled }),
    arc_accounts_remove: async ({ id }) => proxyArc("arc.accounts.remove", { id }),
    arc_accounts_reorder: async ({ family, orderedIds }) => proxyArc("arc.accounts.reorder", { family, orderedIds }),
    arc_login_openai_start: async () => proxyArc("arc.login.openai.start", null),
    arc_login_openai_poll: async ({ sessionId }) => proxyArc("arc.login.openai.poll", { sessionId }),
    arc_login_openai_cancel: async ({ sessionId }) => proxyArc("arc.login.openai.cancel", { sessionId }),
    arc_login_claude_start: async () => proxyArc("arc.login.claude.start", null),
    arc_login_claude_complete: async ({ sessionId, code }) => proxyArc("arc.login.claude.complete", { sessionId, code }),
    arc_omp_providers: async () => proxyArc("arc.omp.providers", null),
    arc_omp_login_start: async ({ provider }) => proxyArc("arc.omp.login.start", { provider }),
    arc_omp_login_poll: async ({ sessionId }) => proxyArc("arc.omp.login.poll", { sessionId }),
    arc_omp_login_cancel: async ({ sessionId }) => proxyArc("arc.omp.login.cancel", { sessionId }),
    arc_omp_login_submit_key: async ({ sessionId, key }) => proxyArc("arc.omp.login.submitKey", { sessionId, key }),
    arc_usage_snapshot: async () => proxyArc("arc.usage.snapshot", null),
    arc_usage_refresh: async ({ resourceId }) =>
      proxyArc("arc.usage.refresh", resourceId === undefined ? {} : { resourceId }),
  });

  // Advertise the reporting tool to every provider session. Reporting never
  // grants permissions; it only writes plugin-owned state.
  bb.agents.configure(() => ({ tools: ["report_mission_state", "resolve_mission_role"], skills: [] }));

  // -- Agent-facing state feed --------------------------------------------------

  bb.agents.registerTool({
    name: "report_mission_state",
    description:
      "Report the current mission-control workflow state (task classification, phase, " +
      "approval scope, verification expectations) so the Mission Control dashboard can display it. " +
      "Only report fields you are confident about; omit the rest. The value is labeled " +
      '"agent-reported" in the UI and never grants permissions by itself.',
    instructions:
      "Call after classifying the user's task with the using-adnan-workflow skill (or when the " +
      "classification, phase, or verification expectations change). Never call it to claim " +
      "verification passed — evidence comes from real runs, not reports.",
    presentation: {
      label: {
        pending: "Reporting mission state",
        completed: "Reported mission state",
      },
    },
    parameters: missionValuesSchema.partial(),
    async execute(input, context) {
      const state = await writeMission(input, "agent-reported", "agent-tool");
      bb.log.info(`mission state updated by tool from thread ${context.threadId ?? "unknown"}`);
      return `Mission state recorded (${Object.keys(input).join(", ")}). Updated at ${new Date(state.updatedAt).toISOString()}.`;
    },
  });

  // Read-only role lookup: lets a workflow say "Delegate -> REVIEW" without
  // hardcoding provider/model pairs. Resolving grants nothing and starts no
  // threads — dispatch remains a separate, approval-gated step.
  bb.agents.registerTool({
    name: "resolve_mission_role",
    description:
      "Resolve a Mission Control role (PLAN, TASK, ADVISOR, ARCHITECT, DESIGNER, REVIEW, " +
      "COMMIT, SLOW, SMOL, or a custom role) to its configured provider, model, reasoning level, " +
      "service tier, and permission mode. Use instead of hardcoding provider/model pairs when " +
      "choosing an execution target. Read-only: resolving a role grants no permissions and starts " +
      "no threads.",
    instructions:
      "Call when you need an execution target for a conceptual role. Returns null fields for " +
      "unmapped roles; check the issues field for mappings that no longer resolve against the " +
      "live provider catalog.",
    presentation: {
      label: {
        pending: "Resolving role",
        completed: "Resolved role",
      },
    },
    parameters: z.object({ role: z.string().min(1).max(40) }),
    async execute(input) {
      const state = await readRoles();
      const wanted = input.role.trim().toLowerCase();
      const mapping = state.roles.find((role) => role.id === wanted || role.label.toLowerCase() === wanted) ?? null;
      if (mapping === null) {
        return JSON.stringify({ found: false, knownRoles: state.roles.map((role) => role.label) });
      }
      const catalog = await fetchCatalog();
      return JSON.stringify({ found: true, mapping, issues: computeRoleIssues([mapping], catalog) });
    },
  });

  // -- CLI ----------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb mission-control get [--json]",
    "  bb mission-control set <key>=<value> ... [--as-user] [--json]",
    "  bb mission-control clear [--json]",
    "  bb mission-control probe [--json]",
    "  bb mission-control evidence [--json]",
    "  bb mission-control roles get [--json]",
    "  bb mission-control roles clear [--json]",
    "  bb mission-control approvals get [--json]",
    "  bb mission-control approvals set <category>=true|false ... [--json]",
    "  bb mission-control approvals clear [--json]",
    "",
    "Keys: task, intent, risk (low|normal|high), phase, domains, concerns,",
    "      skills, allowed, blocked, scope-phase, verification",
    "List values are comma-separated; verification entries are Label:status",
    "pairs with status pending|passed|failed|not-required.",
    "Default provenance is agent-reported; --as-user marks the write user-confirmed.",
    "Role mappings are configured in the Mission Control UI; the CLI is read-only",
    "except `roles clear`, which resets mappings to the default unmapped roles.",
    `Approval categories: ${APPROVAL_CATEGORIES.map((c) => c.id).join(", ")}.`,
    "Every `approvals set` is a deliberate user action — nothing is ever auto-approved.",
  ].join("\n");

  function parseSetArgs(args: string[]): { patch: Partial<MissionValues>; asUser: boolean } {
    const asUser = args.includes("--as-user");
    const tokens = args.filter((arg) => arg !== "--as-user" && arg !== "--json");
    const patch: Partial<MissionValues> = {};
    for (const token of tokens) {
      const eq = token.indexOf("=");
      if (eq <= 0) continue;
      const key = token.slice(0, eq).toLowerCase();
      const value = token.slice(eq + 1).trim();
      const list = () =>
        value === "" ? [] : value.split(",").map((item) => item.trim()).filter((item) => item !== "");
      switch (key) {
        case "task":
          patch.task = value === "" ? null : value.slice(0, 300);
          break;
        case "intent":
          patch.intent = value === "" ? null : value.slice(0, 40);
          break;
        case "risk":
          if (value !== "low" && value !== "normal" && value !== "high" && value !== "") {
            throw new Error(`risk must be low|normal|high, got "${value}"`);
          }
          patch.risk = value === "" ? null : value;
          break;
        case "phase":
          patch.phase = value === "" ? null : value.slice(0, 60);
          break;
        case "domains":
          patch.domains = list().slice(0, 8);
          break;
        case "concerns":
          patch.concerns = list().slice(0, 8);
          break;
        case "skills":
          patch.activeSkills = list().slice(0, 12);
          break;
        case "allowed":
        case "blocked":
        case "scope-phase": {
          const scope = patch.approvalScope ?? { phase: null, allowed: [], blocked: [] };
          if (key === "allowed") scope.allowed = list().slice(0, 12);
          if (key === "blocked") scope.blocked = list().slice(0, 12);
          if (key === "scope-phase") scope.phase = value === "" ? null : value.slice(0, 80);
          patch.approvalScope = scope;
          break;
        }
        case "verification":
          patch.verification = list()
            .slice(0, 12)
            .map((entry) => {
              const sep = entry.lastIndexOf(":");
              const label = sep > 0 ? entry.slice(0, sep) : entry;
              const status = sep > 0 ? entry.slice(sep + 1) : "pending";
              if (!["pending", "passed", "failed", "not-required"].includes(status)) {
                throw new Error(`verification status must be pending|passed|failed|not-required, got "${status}"`);
              }
              return { label: label.slice(0, 80), status: status as "pending" | "passed" | "failed" | "not-required" };
            });
          break;
      }
    }
    return { patch, asUser };
  }

  function formatMission(state: MissionState | null): string {
    if (state === null) return "No mission state recorded yet.";
    const p = (field: string) => state.fieldProvenance[field] ?? "agent-reported";
    const badge = (field: string) => `[${p(field)}]`;
    const v = state.values;
    const lines = [
      `updated ${new Date(state.updatedAt).toISOString()} by ${state.updatedBy}`,
      `task      ${badge("task")} ${v.task ?? "—"}`,
      `intent    ${badge("intent")} ${v.intent ?? "—"}`,
      `domains   ${badge("domains")} ${v.domains.join(", ") || "—"}`,
      `concerns  ${badge("concerns")} ${v.concerns.join(", ") || "—"}`,
      `risk      ${badge("risk")} ${v.risk ?? "—"}`,
      `phase     ${badge("phase")} ${v.phase ?? "—"}`,
      `skills    ${badge("activeSkills")} ${v.activeSkills.join(", ") || "—"}`,
    ];
    if (v.approvalScope !== null) {
      lines.push(`scope     ${badge("approvalScope")} ${v.approvalScope.phase ?? "—"}`);
      lines.push(`  allowed:  ${v.approvalScope.allowed.join(", ") || "—"}`);
      lines.push(`  blocked:  ${v.approvalScope.blocked.join(", ") || "—"}`);
    }
    if (v.verification.length > 0) {
      lines.push(`verification ${badge("verification")}`);
      for (const item of v.verification) {
        const evidence = item.evidence ?? null;
        const suffix = evidence !== null ? ` — evidence: exit ${evidence.exitCode ?? "?"} (${evidence.threadTitle})` : "";
        lines.push(`  [${item.status}] ${item.label}${suffix}`);
      }
    }
    return lines.join("\n");
  }

  bb.cli.register({
    name: "mission-control",
    summary: "Read and update the Adnan Mission Control workflow state",
    commands: [
      { name: "get", summary: "Show the current mission state", usage: "bb mission-control get [--json]" },
      { name: "set", summary: "Set mission state fields", usage: "bb mission-control set <key>=<value> ... [--as-user]" },
      { name: "clear", summary: "Clear the mission state", usage: "bb mission-control clear" },
      { name: "probe", summary: "Run the provider capability probe", usage: "bb mission-control probe [--json]" },
      {
        name: "evidence",
        summary: "List recent observed command executions (verification evidence)",
        usage: "bb mission-control evidence [--json]",
      },
      { name: "roles", summary: "Show or reset the role router mappings", usage: "bb mission-control roles get|clear [--json]" },
      {
        name: "approvals",
        summary: "Show, set, or reset the Approval Center categories",
        usage: "bb mission-control approvals get|set <category>=true|false ...|clear [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "get": {
          const state = await readMission();
          return reply(state, formatMission(state));
        }
        case "set": {
          if (args.length === 0) return { exitCode: 1, stderr: usage };
          const { patch, asUser } = parseSetArgs(args);
          if (Object.keys(patch).length === 0) return { exitCode: 1, stderr: usage };
          const state = await writeMission(patch, asUser ? "user-confirmed" : "agent-reported", "cli");
          return reply(state, formatMission(state));
        }
        case "clear":
          await bb.storage.kv.delete(KV_MISSION);
          publishChange("mission");
          return reply({ cleared: true }, "Mission state cleared.");
        case "probe":
          return reply(await runProbe(), "Probe complete. See the Mission Control panel for details.");
        case "evidence": {
          const evidence = await fetchCommandEvidence();
          const text =
            evidence.length === 0
              ? "No observed command executions yet."
              : evidence
                  .map((entry) => `[${entry.exitCode === null ? "?" : entry.exitCode}] ${entry.command}  (${entry.threadTitle})`)
                  .join("\n");
          return reply({ evidence }, text);
        }
        case "roles": {
          const [sub] = args;
          if (sub === undefined || sub === "get") {
            const state = await readRoles();
            const catalog = await fetchCatalog();
            const issues = computeRoleIssues(state.roles, catalog);
            const text = [
              `role mappings updated ${new Date(state.updatedAt).toISOString()} by ${state.updatedBy}`,
              ...state.roles.map((role) => {
                const target =
                  role.providerId === null
                    ? "unassigned"
                    : `${role.providerId} / ${role.model ?? "?"} / ${role.reasoningLevel ?? "default"}${role.serviceTier !== null ? ` / tier:${role.serviceTier}` : ""}`;
                const flagged = issues.filter((issue) => issue.roleId === role.id);
                return `${role.label.padEnd(10)} ${target}${flagged.length > 0 ? `  ⚠ ${flagged.map((issue) => issue.message).join("; ")}` : ""}`;
              }),
            ].join("\n");
            return reply({ state, catalog, issues }, text);
          }
          if (sub === "clear") {
            await bb.storage.kv.delete(KV_ROLES);
            publishChange("roles");
            return reply({ cleared: true }, "Role mappings reset to defaults.");
          }
          return { exitCode: 1, stderr: usage };
        }
        case "approvals": {
          const [sub, ...rest] = args;
          if (sub === undefined || sub === "get") {
            const state = await readApprovals();
            const text = [
              `approvals updated ${state.updatedAt === 0 ? "never" : new Date(state.updatedAt).toISOString()} by ${state.updatedBy}`,
              ...APPROVAL_CATEGORIES.map(
                (category) => `${(state.approvals[category.id] === true ? "✓" : "✗").padEnd(2)} ${category.label}`,
              ),
            ].join("\n");
            return reply({ state, categories: APPROVAL_CATEGORIES }, text);
          }
          if (sub === "set") {
            const patch: Record<string, boolean> = {};
            for (const token of rest) {
              const eq = token.indexOf("=");
              if (eq <= 0) continue;
              const id = token.slice(0, eq).toLowerCase();
              const value = token.slice(eq + 1).trim().toLowerCase();
              if (!APPROVAL_CATEGORY_IDS.includes(id)) {
                return { exitCode: 1, stderr: `Unknown approval category "${id}". Known: ${APPROVAL_CATEGORY_IDS.join(", ")}` };
              }
              if (value !== "true" && value !== "false") {
                return { exitCode: 1, stderr: `Approval value must be true|false, got "${value}"` };
              }
              patch[id] = value === "true";
            }
            if (Object.keys(patch).length === 0) return { exitCode: 1, stderr: usage };
            const state = await writeApprovals(patch, "cli");
            return reply({ state }, "Approvals updated.");
          }
          if (sub === "clear") {
            await bb.storage.kv.delete(KV_APPROVALS);
            publishChange("approvals");
            return reply({ cleared: true }, "Approvals reset to defaults (nothing approved).");
          }
          return { exitCode: 1, stderr: usage };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  // -- Cleanup ------------------------------------------------------------------

  bb.onDispose(() => {
    if (publishTimer !== null) clearTimeout(publishTimer);
    enrichmentCache.clear();
    bb.log.info("disposed");
  });
}
