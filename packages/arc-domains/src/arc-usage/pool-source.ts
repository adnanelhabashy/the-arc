import { z } from "zod";
import type { ArcAgentId } from "../arc-agent/types.js";
import {
  ArcUsageError,
  type ArcUsageResource,
  type ArcUsageSource,
  type ArcUsageWindow,
  type ArcUsageWindowKind,
} from "./types.js";
import type { AccountPoolRpcClient } from "../arc-account/account-pool-source.js";

// Arc adapter over Account Pool's generic usage-source RPC
// (plugins/account-pool/src/usage-contract.ts:
// provider-usage.v1.listResources / provider-usage.v1.getResource). The
// pool owns all quota fetching; this file only validates the wire shapes
// locally and maps them into the Arc usage model. No quota logic is
// reimplemented and no pool internals are rewritten.

const LIST_METHOD = "provider-usage.v1.listResources";
const FETCH_METHOD = "provider-usage.v1.getResource";

const usagePlanSchema = z.object({
  id: z.string().min(1),
  multiplier: z.number().int().positive().nullable(),
});

const usageWindowSchema = z.object({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z
    .object({
      usedUsdCents: z.number().nonnegative(),
      limitUsdCents: z.number().positive(),
    })
    .nullable(),
});

const usageStatusSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    plan: usagePlanSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    windows: z.array(usageWindowSchema),
  }),
  z.object({
    status: z.literal("not_installed"),
    plan: usagePlanSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  }),
  z.object({
    status: z.literal("unauthenticated"),
    plan: usagePlanSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  }),
  z.object({
    status: z.literal("expired"),
    plan: usagePlanSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  }),
  z.object({
    status: z.literal("error"),
    plan: usagePlanSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    message: z.string(),
  }),
]);

const listOutputSchema = z.object({
  label: z.string().min(1).optional(),
  resources: z.array(
    z.object({
      accountKey: z.string().min(1).nullable(),
      id: z.string().min(1),
      providerId: z.string().min(1),
      label: z.string().min(1),
      scope: z.object({
        kind: z.enum(["shared", "host"]),
        hostId: z.string().optional(),
        hostName: z.string().optional(),
      }),
    }),
  ),
});

const fetchOutputSchema = z.object({
  accountKey: z.string().min(1).nullable(),
  observedAt: z.number().int().nonnegative().nullable(),
  usage: usageStatusSchema,
});

function parse<Output>(
  schema: z.ZodType<Output>,
  value: unknown,
  what: string,
): Output {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ArcUsageError(
      "usage-contract-invalid",
      `account pool ${what} returned an invalid payload: ${result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

const AGENT_BY_PROVIDER: Record<string, ArcAgentId> = {
  codex: "codex",
  "claude-code": "claude-code",
};

const FAMILY_BY_PROVIDER: Record<string, string> = {
  codex: "openai",
  "claude-code": "anthropic",
};

const LABEL_BY_PROVIDER: Record<string, string> = {
  codex: "ChatGPT",
  "claude-code": "Claude",
};

function mapWindows(
  windows: z.infer<typeof usageWindowSchema>[],
): ArcUsageWindow[] {
  return windows.map((window) => {
    const resetsAt = window.resetsAt === null ? null : Date.parse(window.resetsAt);
    return {
      id: window.id,
      label: window.label,
      kind: window.kind as ArcUsageWindowKind,
      status: null,
      usedPercent: window.usedPercent,
      remainingPercent: 100 - window.usedPercent,
      usedAmount: window.cost?.usedUsdCents ?? null,
      limitAmount: window.cost?.limitUsdCents ?? null,
      remainingAmount: null,
      unit: window.cost !== null ? ("usd" as const) : ("percent" as const),
      resetsAt:
        resetsAt !== null && Number.isFinite(resetsAt) ? resetsAt : null,
      observedAt: null,
      source: null,
    };
  });
}

function baseResource(
  listed: z.infer<typeof listOutputSchema>["resources"][number],
): ArcUsageResource {
  const agentId = AGENT_BY_PROVIDER[listed.providerId] ?? null;
  return {
    id: `pool:${FAMILY_BY_PROVIDER[listed.providerId] ?? listed.providerId}:${listed.id}`,
    sourceKind: "pool",
    accountKey: listed.accountKey,
    accountSourceId: listed.id,
    providerFamily: FAMILY_BY_PROVIDER[listed.providerId] ?? null,
    providerLabel: LABEL_BY_PROVIDER[listed.providerId] ?? listed.providerId,
    accountEmail: null,
    planLabel: null,
    modelLabel: null,
    agentIds: agentId === null ? [] : [agentId],
    windows: [],
    observedAt: null,
    fetchedAt: null,
    stale: false,
    status: "unknown",
    unavailableReason: null,
    credentialDisabled: false,
    message: null,
    sources: ["pool"],
  };
}

export interface ArcPoolUsageSourceArgs {
  rpc: AccountPoolRpcClient;
  now?: () => number;
}

export class ArcPoolUsageSource implements ArcUsageSource {
  readonly kind = "pool" as const;
  private readonly rpc: AccountPoolRpcClient;
  private readonly now: () => number;

  constructor(args: ArcPoolUsageSourceArgs) {
    this.rpc = args.rpc;
    this.now = args.now ?? Date.now;
  }

  // Cheap metadata-only inventory; never refreshes quota.
  async list(): Promise<ArcUsageResource[]> {
    const output = parse(
      listOutputSchema,
      await this.rpc.call(LIST_METHOD, {}),
      "listResources",
    );
    return output.resources.map(baseResource);
  }

  async fetch(
    resourceId: string,
    refresh: boolean,
  ): Promise<ArcUsageResource> {
    const listed = parse(
      listOutputSchema,
      await this.rpc.call(LIST_METHOD, {}),
      "listResources",
    );
    const localId = resourceId.startsWith("pool:")
      ? resourceId.slice(resourceId.indexOf(":", 5) + 1)
      : resourceId;
    const resource = listed.resources.find((entry) => entry.id === localId);
    if (resource === undefined) {
      throw new ArcUsageError(
        "usage-resource-not-found",
        `account pool usage resource ${resourceId} no longer exists`,
      );
    }
    const measurement = parse(
      fetchOutputSchema,
      await this.rpc.call(FETCH_METHOD, {
        resourceId: resource.id,
        refresh,
      }),
      "getResource",
    );
    const base = baseResource(resource);
    const usage = measurement.usage;
    return {
      ...base,
      accountEmail: usage.accountEmail,
      planLabel: usage.planLabel,
      modelLabel: usage.status === "ok" ? null : null,
      windows: usage.status === "ok" ? mapWindows(usage.windows) : [],
      observedAt: measurement.observedAt,
      fetchedAt: this.now(),
      status:
        usage.status === "ok"
          ? "available"
          : usage.status === "error"
            ? "error"
            : "unavailable",
      unavailableReason:
        usage.status === "ok"
          ? null
          : usage.status === "error"
            ? null
            : "not-connected",
      message:
        usage.status === "error"
          ? "Usage could not be collected for this account. Try refreshing usage."
          : usage.status === "ok"
            ? null
            : `Usage is unavailable for this account (${usage.status}).`,
    };
  }
}
