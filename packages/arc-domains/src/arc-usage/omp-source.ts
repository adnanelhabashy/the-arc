import { z } from "zod";
import type { ArcAccount } from "../arc-account/types.js";
import {
  ArcUsageError,
  type ArcUsageResource,
  type ArcUsageSource,
  type ArcUsageWindow,
  type ArcUsageWindowKind,
} from "./types.js";

// Arc adapter over OMP 18.2.6 usage data. Reports come from the auth
// broker's GET /v1/usage ({generatedAt, reports[]}) and disabled-credential
// tombstones from GET /v1/credentials/disabled; both ride the Phase 8 lazy
// loopback broker lifecycle, so a usage refresh never starts `omp acp` and
// never leaves the broker running after the idle timeout. The broker has no
// force-refresh parameter: a refresh request is a fetch attempt whose
// freshness is bounded by OMP's own five-minute per-credential server cache.
// Wire payloads are validated here and mapped through explicit allowlists;
// report `metadata` contributes display fields only (email, org, plan).

export interface ArcOmpUsageGateway {
  fetchUsageSnapshot(): Promise<{ usage: unknown; disabled: unknown }>;
  listOmpAccounts(): Promise<ArcAccount[]>;
}

const usageWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  durationMs: z.number().optional(),
  resetsAt: z.number().optional(),
});

const usageAmountSchema = z.object({
  used: z.number().optional(),
  limit: z.number().optional(),
  remaining: z.number().optional(),
  usedFraction: z.number().optional(),
  remainingFraction: z.number().optional(),
  unit: z.enum([
    "percent",
    "tokens",
    "requests",
    "credits",
    "usd",
    "minutes",
    "bytes",
    "unknown",
  ]),
});

const usageLimitSchema = z.object({
  id: z.string(),
  label: z.string(),
  scope: z.object({
    provider: z.string(),
    accountId: z.string().optional(),
    orgId: z.string().optional(),
    projectId: z.string().optional(),
    modelId: z.string().optional(),
    tier: z.string().optional(),
  }),
  window: usageWindowSchema.optional(),
  amount: usageAmountSchema,
  status: z.enum(["ok", "warning", "exhausted", "unknown"]).optional(),
  notes: z.array(z.string()).optional(),
});

const reportMetadataSchema = z
  .object({
    email: z.string().optional(),
    accountId: z.string().optional(),
    orgId: z.string().optional(),
    orgName: z.string().optional(),
    planType: z.string().optional(),
  })
  .partial();

const usageReportSchema = z.object({
  provider: z.string().min(1),
  fetchedAt: z.number(),
  limits: z.array(usageLimitSchema),
  notes: z.array(z.string()).optional(),
  metadata: reportMetadataSchema.optional(),
});

const usageResponseSchema = z.object({
  generatedAt: z.number(),
  reports: z.array(usageReportSchema),
});

const disabledEntrySchema = z.object({
  id: z.number().optional(),
  provider: z.string(),
  type: z.string().optional(),
  email: z.string().optional(),
  accountId: z.string().optional(),
  orgId: z.string().optional(),
  orgName: z.string().optional(),
  cause: z.string().optional(),
  disabledAtMs: z.number().optional(),
});

const disabledResponseSchema = z.object({
  generatedAt: z.number(),
  disabled: z.array(disabledEntrySchema).optional(),
});

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function windowKind(
  window: z.infer<typeof usageWindowSchema> | undefined,
): ArcUsageWindowKind {
  if (window === undefined) return "custom";
  const id = window.id.toLowerCase();
  const label = window.label.toLowerCase();
  if (
    id === "5h" ||
    id === "five-hour" ||
    id === "5_hour" ||
    label.includes("5 hour") ||
    label.includes("five-hour") ||
    label.includes("5-hour") ||
    window.durationMs === FIVE_HOURS_MS
  ) {
    return "five-hour";
  }
  if (
    id === "24h" ||
    id === "1d" ||
    id === "daily" ||
    label.includes("daily") ||
    label.includes("24 hour") ||
    window.durationMs === DAY_MS
  ) {
    return "daily";
  }
  if (
    id === "7d" ||
    id === "weekly" ||
    label.includes("weekly") ||
    label.includes("7 day") ||
    window.durationMs === WEEK_MS
  ) {
    return "weekly";
  }
  if (
    id === "monthly" ||
    id === "30d" ||
    label.includes("monthly") ||
    window.durationMs === 30 * DAY_MS
  ) {
    return "monthly";
  }
  return "custom";
}

// Percentages are derived only from true fractions: an explicit
// used/remaining fraction, or used/limit where the denominator is real and
// positive. Unbounded amounts (credits, dollars, tokens without a limit)
// stay amount-only — never converted into invented percentages.
function mapAmount(amount: z.infer<typeof usageAmountSchema>): {
  usedPercent: number | null;
  remainingPercent: number | null;
  usedAmount: number | null;
  limitAmount: number | null;
  remainingAmount: number | null;
} {
  const asPercent = (fraction: number): number => fraction * 100;
  if (amount.unit === "percent") {
    if (amount.usedFraction !== undefined) {
      return {
        usedPercent: asPercent(amount.usedFraction),
        remainingPercent:
          amount.remainingFraction !== undefined
            ? asPercent(amount.remainingFraction)
            : 100 - asPercent(amount.usedFraction),
        usedAmount: amount.used ?? null,
        limitAmount: amount.limit ?? null,
        remainingAmount: amount.remaining ?? null,
      };
    }
    if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
      const usedPercent = (amount.used / amount.limit) * 100;
      return {
        usedPercent,
        remainingPercent: 100 - usedPercent,
        usedAmount: amount.used,
        limitAmount: amount.limit,
        remainingAmount: amount.remaining ?? null,
      };
    }
    if (amount.remainingFraction !== undefined) {
      return {
        usedPercent: 100 - asPercent(amount.remainingFraction),
        remainingPercent: asPercent(amount.remainingFraction),
        usedAmount: amount.used ?? null,
        limitAmount: amount.limit ?? null,
        remainingAmount: amount.remaining ?? null,
      };
    }
    if (amount.used !== undefined) {
      return {
        usedPercent: amount.used,
        remainingPercent: amount.remaining ?? null,
        usedAmount: amount.used,
        limitAmount: amount.limit ?? null,
        remainingAmount: amount.remaining ?? null,
      };
    }
    return {
      usedPercent: null,
      remainingPercent: null,
      usedAmount: null,
      limitAmount: amount.limit ?? null,
      remainingAmount: amount.remaining ?? null,
    };
  }
  return {
    usedPercent: null,
    remainingPercent: null,
    usedAmount: amount.used ?? null,
    limitAmount: amount.limit ?? null,
    remainingAmount: amount.remaining ?? null,
  };
}

function mapLimit(
  limit: z.infer<typeof usageLimitSchema>,
  observedAt: number,
): ArcUsageWindow {
  const amounts = mapAmount(limit.amount);
  return {
    id: limit.id,
    label: limit.label,
    kind: windowKind(limit.window),
    status: limit.status ?? null,
    ...amounts,
    unit: limit.amount.unit,
    resetsAt: limit.window?.resetsAt ?? null,
    observedAt,
    source: null,
  };
}

function parseWire(payload: {
  usage: unknown;
  disabled: unknown;
}): {
  usage: z.infer<typeof usageResponseSchema>;
  disabled: z.infer<typeof disabledEntrySchema>[];
} {
  const usage = usageResponseSchema.safeParse(payload.usage);
  if (!usage.success) {
    throw new ArcUsageError(
      "usage-contract-invalid",
      `OMP broker /v1/usage returned an invalid payload: ${usage.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
  let disabled: z.infer<typeof disabledEntrySchema>[] = [];
  if (payload.disabled !== null) {
    const parsed = disabledResponseSchema.safeParse(payload.disabled);
    disabled = parsed.success ? (parsed.data.disabled ?? []) : [];
  }
  return { usage: usage.data, disabled };
}

function accountIdentity(
  account: ArcAccount,
): { provider: string; accountId: string | null } {
  if (account.accountKey === null) {
    return { provider: account.providerFamily ?? "", accountId: null };
  }
  const parts = account.accountKey.split(":");
  return {
    provider: account.providerFamily ?? parts[1] ?? "",
    accountId: parts.length >= 3 ? parts.slice(2).join(":") : null,
  };
}

function isCovered(
  account: ArcAccount,
  reports: z.infer<typeof usageReportSchema>[],
): boolean {
  const identity = accountIdentity(account);
  for (const report of reports) {
    if (report.provider !== identity.provider) continue;
    const scopeIds = report.limits
      .map((limit) => limit.scope)
      .filter(
        (scope) =>
          scope.accountId !== undefined ||
          scope.orgId !== undefined ||
          scope.projectId !== undefined,
      );
    const identityFields = [
      ...scopeIds.flatMap((scope) => [scope.accountId, scope.orgId, scope.projectId]),
      report.metadata?.accountId,
    ].filter((value): value is string => value !== undefined);
    if (identity.accountId !== null) {
      if (identityFields.includes(identity.accountId)) return true;
      continue;
    }
    // API-key accounts carry no trustworthy identity: they are covered only
    // by a single-identity provider report that names no account at all.
    if (identityFields.length === 0 && report.limits.length > 0) return true;
  }
  return false;
}

export interface ArcOmpUsageSourceArgs {
  gateway: ArcOmpUsageGateway;
  now?: () => number;
}

export class ArcOmpUsageSource implements ArcUsageSource {
  readonly kind = "omp" as const;
  private readonly gateway: ArcOmpUsageGateway;
  private readonly now: () => number;

  constructor(args: ArcOmpUsageSourceArgs) {
    this.gateway = args.gateway;
    this.now = args.now ?? Date.now;
  }

  // Resource inventory comes from the account inventory correlation plus
  // the last cached usage fetch; a cold list with no cache reports account
  // resources as "unknown" usage without contacting the broker.
  async list(): Promise<ArcUsageResource[]> {
    const accounts = await this.gateway.listOmpAccounts();
    return accounts.map((account) => ({
      id: `omp:${account.providerFamily ?? "unknown"}:${account.id}`,
      sourceKind: "omp" as const,
      accountKey: account.accountKey,
      accountSourceId: account.id,
      providerFamily: account.providerFamily,
      providerLabel: account.providerLabel,
      accountEmail: account.email,
      planLabel: account.planLabel,
      modelLabel: null,
      agentIds: ["omp" as const],
      windows: [],
      observedAt: null,
      fetchedAt: null,
      stale: false,
      status: "unknown" as const,
      unavailableReason: null,
      credentialDisabled: account.authState === "disabled",
      message: null,
      sources: ["omp" as const],
    }));
  }

  // Fetches fresh usage for every OMP resource. The broker has no
  // per-resource refresh flag, so refresh applies to the whole snapshot;
  // per-resource fetch returns the cached snapshot's matching resource.
  async fetch(
    resourceId: string,
    refresh: boolean,
  ): Promise<ArcUsageResource> {
    void refresh;
    const [{ usage, disabled }, accounts] = await Promise.all([
      this.gateway.fetchUsageSnapshot().catch((error: unknown) => {
        throw new ArcUsageError(
          "usage-fetch-failed",
          `OMP usage fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }),
      this.gateway.listOmpAccounts(),
    ]);
    const wire = parseWire({ usage, disabled });
    const resources = this.mapResources(wire.usage, wire.disabled, accounts);
    const resource = resources.find((entry) => entry.id === resourceId);
    if (resource === undefined) {
      throw new ArcUsageError(
        "usage-resource-not-found",
        `OMP usage resource ${resourceId} was not reported by the broker`,
      );
    }
    return resource;
  }

  private mapResources(
    usage: z.infer<typeof usageResponseSchema>,
    disabled: z.infer<typeof disabledEntrySchema>[],
    accounts: ArcAccount[],
  ): ArcUsageResource[] {
    const resources: ArcUsageResource[] = [];
    const disabledKeys = new Set(
      disabled.map(
        (entry) => `${entry.provider}:${entry.accountId ?? entry.email ?? ""}`,
      ),
    );
    for (const report of usage.reports) {
      const metadata = report.metadata ?? {};
      const scopeIds = report.limits
        .map((limit) => limit.scope.accountId)
        .filter((id): id is string => id !== undefined);
      const accountId = scopeIds[0] ?? metadata.accountId ?? null;
      const account = accounts.find(
        (entry) =>
          entry.providerFamily === report.provider &&
          (accountId === null ||
            accountIdentity(entry).accountId === accountId),
      );
      const disabledKey = `${report.provider}:${accountId ?? metadata.email ?? ""}`;
      resources.push({
        id: `omp:${report.provider}:${account?.id ?? accountId ?? "report"}`,
        sourceKind: "omp",
        accountKey: account?.accountKey ?? null,
        accountSourceId: account?.id ?? null,
        providerFamily: report.provider,
        providerLabel: account?.providerLabel ?? report.provider,
        accountEmail: metadata.email ?? account?.email ?? null,
        planLabel: metadata.planType ?? account?.planLabel ?? null,
        modelLabel: null,
        agentIds: ["omp"],
        windows: report.limits.map((limit) =>
          mapLimit(limit, report.fetchedAt),
        ),
        observedAt: report.fetchedAt,
        fetchedAt: this.now(),
        stale: false,
        status: "available",
        unavailableReason: null,
        credentialDisabled: disabledKeys.has(disabledKey),
        message: null,
        sources: ["omp"],
      });
    }
    // Accounts the broker did not report: provider does not expose usage
    // (not-exposed) or the credential is provider-disabled. UNKNOWN != ZERO.
    for (const account of accounts) {
      if (isCovered(account, usage.reports)) continue;
      const identity = accountIdentity(account);
      const disabledKey = `${identity.provider}:${identity.accountId ?? account.email ?? ""}`;
      const credentialDisabled =
        account.authState === "disabled" || disabledKeys.has(disabledKey);
      resources.push({
        id: `omp:${account.providerFamily ?? "unknown"}:${account.id}`,
        sourceKind: "omp",
        accountKey: account.accountKey,
        accountSourceId: account.id,
        providerFamily: account.providerFamily,
        providerLabel: account.providerLabel,
        accountEmail: account.email,
        planLabel: account.planLabel,
        modelLabel: null,
        agentIds: ["omp"],
        windows: [],
        observedAt: null,
        fetchedAt: this.now(),
        stale: false,
        status: "unavailable",
        unavailableReason: credentialDisabled ? "disabled" : "not-exposed",
        credentialDisabled,
        message: null,
        sources: ["omp"],
      });
    }
    return resources;
  }
}
