import { useEffect, useState, type ReactNode } from "react";
import {
  useArcCurrentAgentUsage,
  useArcUsageRefresh,
  type ArcAgentId,
  type ArcCurrentAgentUsage,
  type ArcUsageResource,
  type ArcUsageWindow,
} from "@/hooks/queries/arc-queries";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { getProviderIconInfo } from "@/lib/provider-icon";

interface ProviderUsageSectionProps {
  active: boolean;
  providerId: string | undefined;
  modelLabel?: string;
  // The thread's bound account, when known. Undefined renders "Active
  // account unknown" instead of guessing from every connected account.
  accountKey?: string | null;
}

function isArcUnavailableError(error: unknown): boolean {
  if (error instanceof Error) return error.message.includes("arc-unavailable");
  if (typeof error === "string") return error.includes("arc-unavailable");
  return false;
}

export function providerIdToAgentId(providerId: string | undefined): ArcAgentId | null {
  switch (providerId) {
    case "codex":
      return "codex";
    case "claude-code":
      return "claude-code";
    case "acp-omp":
      return "omp";
    default:
      return null;
  }
}

export function ProviderUsageSection({
  active,
  providerId,
  modelLabel,
  accountKey,
}: ProviderUsageSectionProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [active]);

  const agentId = providerIdToAgentId(providerId);
  const usageQuery = useArcCurrentAgentUsage({
    agentId,
    accountKey,
    enabled: active && agentId !== null,
  });
  const refreshMutation = useArcUsageRefresh();

  if (agentId === null) return null;
  if (
    usageQuery.error !== null &&
    isArcUnavailableError(usageQuery.error)
  ) {
    return null;
  }

  if (usageQuery.data === undefined) {
    if (usageQuery.isError) {
      return (
        <UsageUnavailableLine
          onRefresh={() => {
            void refreshMutation.mutate();
          }}
        />
      );
    }
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-2xs text-muted-foreground">
          Loading provider…
        </span>
      </div>
    );
  }

  const usage = usageQuery.data;
  if (usage.resources.length === 0 && !usage.activeAccountUnknown) {
    return null;
  }

  // agentId is non-null only for the three known provider IDs, so providerId
  // is defined here.
  const knownProviderId = providerId as string;

  return (
    <ProviderUsagePanel
      providerId={knownProviderId}
      usage={usage}
      isFetching={usageQuery.isFetching || refreshMutation.isPending}
      onRefresh={() => {
        void refreshMutation.mutate();
      }}
      now={now}
      modelLabel={modelLabel}
    />
  );
}

export interface ProviderUsagePanelProps {
  providerId: string;
  usage: ArcCurrentAgentUsage;
  isFetching: boolean;
  onRefresh: () => void;
  now: number;
  modelLabel?: string;
}

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatReset(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const deltaMinutes = Math.floor((resetsAt - now) / 60_000);
  if (deltaMinutes < 1) return "resets due";
  if (deltaMinutes < 60) return `resets in ${deltaMinutes}m`;
  const hours = Math.floor(deltaMinutes / 60);
  if (hours < 48) return `resets in ${hours}h ${deltaMinutes % 60}m`;
  const date = new Date(resetsAt);
  return `resets ${MONTH_SHORT[date.getMonth()]} ${date.getDate()}`;
}

function relativeAgo(updatedAt: number, now: number): string | null {
  if (updatedAt === 0) return null;
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function formatUpdatedAgo(updatedAt: number, now: number): string | null {
  const relative = relativeAgo(updatedAt, now);
  return relative === null ? null : `Updated ${relative}`;
}

function remainingToneClass(usedPercent: number): string {
  const remaining = 100 - usedPercent;
  if (remaining < 20) return "text-destructive";
  if (remaining <= 50) return "text-warning-text";
  return "text-muted-foreground";
}

function accountLine(resource: ArcUsageResource): string | null {
  const parts = [resource.planLabel, resource.accountEmail].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

function resourceStatusLine(resource: ArcUsageResource): string | null {
  if (resource.status !== "unavailable") return null;
  switch (resource.unavailableReason) {
    case "not-exposed":
      return "Usage limits not exposed by provider";
    case "disabled":
      return "Connected · temporarily unavailable";
    case "not-connected":
      return "Connect an account to see usage";
    default:
      return null;
  }
}

const COMPACT_AMOUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatWholeNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatAmountRemaining(window: ArcUsageWindow): string {
  const amount = window.remainingAmount ?? 0;
  switch (window.unit) {
    case "usd":
      return `$${amount.toFixed(2)} remaining`;
    case "tokens":
      return `${COMPACT_AMOUNT_FORMATTER.format(amount)} tokens remaining`;
    case "credits":
      return `${formatWholeNumber(amount)} credits remaining`;
    case "requests":
      return `${formatWholeNumber(amount)} requests remaining`;
    case "minutes":
      return `${formatWholeNumber(amount)} minutes remaining`;
    case "bytes":
      return `${formatWholeNumber(amount)} bytes remaining`;
    case "percent":
      return `${formatWholeNumber(amount)}% remaining`;
    default:
      return `${formatWholeNumber(amount)} remaining`;
  }
}

function UsageWindowRow({
  window,
  now,
}: {
  window: ArcUsageWindow;
  now: number;
}) {
  if (window.usedPercent !== null) {
    const usedPercent = Math.round(window.usedPercent);
    const leftPercent = Math.max(0, 100 - usedPercent);
    const toneClass = remainingToneClass(usedPercent);
    const resetLabel = formatReset(window.resetsAt, now);
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
          <span className="shrink-0 truncate text-muted-foreground">
            {window.label}
          </span>
          <span className="flex shrink-0 items-baseline gap-2">
            <span className={cn("font-medium", toneClass)}>
              {usedPercent}% used
            </span>
            <span className="w-12 text-right text-muted-foreground">
              {leftPercent}% left
            </span>
          </span>
        </div>
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-border">
          <div
            className={cn("h-full rounded-full bg-current", toneClass)}
            style={{ width: `${Math.min(Math.max(usedPercent, 0), 100)}%` }}
          />
        </div>
        {resetLabel !== null ? (
          <div className="flex items-baseline justify-between gap-2 text-2xs tabular-nums text-muted-foreground">
            <span>{resetLabel}</span>
          </div>
        ) : null}
      </div>
    );
  }

  if (window.remainingAmount !== null) {
    return (
      <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
        <span className="shrink-0 truncate text-muted-foreground">
          {window.label}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {formatAmountRemaining(window)}
        </span>
      </div>
    );
  }

  return null;
}

function UsageUnavailableLine({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-2xs text-muted-foreground">
        Usage temporarily unavailable
      </span>
      <button
        type="button"
        onClick={onRefresh}
        className="cursor-pointer rounded-xs text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Retry
      </button>
    </div>
  );
}

function resourceBody(
  resource: ArcUsageResource,
  now: number,
  onRefresh: () => void,
): ReactNode {
  const statusLine = resourceStatusLine(resource);
  if (statusLine !== null) {
    return (
      <span className="text-2xs text-muted-foreground">{statusLine}</span>
    );
  }
  if (resource.status === "error" && resource.windows.length === 0) {
    return <UsageUnavailableLine onRefresh={onRefresh} />;
  }
  if (resource.windows.length === 0) {
    return (
      <span className="text-2xs text-muted-foreground">No usage reported</span>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {resource.windows.map((window) => (
        <UsageWindowRow key={window.id} window={window} now={now} />
      ))}
    </div>
  );
}

function UsageResourceSection({
  resource,
  providerId,
  now,
  onRefresh,
}: {
  resource: ArcUsageResource;
  providerId: string;
  now: number;
  onRefresh: () => void;
}) {
  const line = accountLine(resource);
  const ProviderGlyph = getProviderIconInfo("agent", providerId).icon;
  const staleRelative = resource.stale
    ? relativeAgo(resource.fetchedAt ?? 0, now)
    : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="flex size-4 shrink-0 items-center justify-center">
          <ProviderGlyph className="size-3.5" />
        </span>
        <span className="truncate font-medium">{resource.providerLabel}</span>
        {line !== null ? (
          <span className="min-w-0 truncate text-2xs text-muted-foreground">
            {line}
          </span>
        ) : null}
      </div>
      <div className="pl-5">{resourceBody(resource, now, onRefresh)}</div>
      {staleRelative !== null ? (
        <span className="pl-5 text-2xs tabular-nums text-muted-foreground">
          Last updated {staleRelative} · could not refresh
        </span>
      ) : null}
    </div>
  );
}

export function ProviderUsagePanel({
  providerId,
  usage,
  isFetching,
  onRefresh,
  now,
  modelLabel,
}: ProviderUsagePanelProps) {
  const latestFetchedAt = usage.resources.reduce(
    (max, resource) => Math.max(max, resource.fetchedAt ?? 0),
    0,
  );
  const updatedLabel = formatUpdatedAgo(latestFetchedAt, now);

  return (
    <div className="flex flex-col gap-1.5">
      {usage.activeAccountUnknown ? (
        <span className="text-2xs text-muted-foreground">
          Active account unknown
        </span>
      ) : usage.resources.length === 0 ? (
        <span className="text-2xs text-muted-foreground">
          No usage reported
        </span>
      ) : (
        usage.resources.map((resource) => (
          <UsageResourceSection
            key={resource.id}
            resource={resource}
            providerId={providerId}
            now={now}
            onRefresh={onRefresh}
          />
        ))
      )}
      {modelLabel ? (
        <span className="truncate pl-5 text-2xs text-muted-foreground">
          Model: {modelLabel}
        </span>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        {updatedLabel !== null ? (
          <span className="text-2xs tabular-nums text-muted-foreground">
            {updatedLabel}
          </span>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <a
            href="/plugins/adnan-mission-control/usage"
            className="text-2xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            View all usage
          </a>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh provider usage"
            className="-m-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon
              name="RotateCcw"
              className={cn("size-3", isFetching && "animate-spin")}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
