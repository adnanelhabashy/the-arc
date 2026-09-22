// Usage & Limits tab (Phase 10): Arc's unified usage model over the three
// agent groups (OMP / Codex / Claude Code). One card per usage resource,
// rendered per the Arc render rules — UNKNOWN is never presented as 0%: a
// resource that does not expose usage says so, an amount-only window renders
// its amount without a fabricated bar, and a failed refresh keeps the last
// good reading marked stale rather than blanking the card.
import { useEffect, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type {
  ArcUsageResource,
  ArcUsageSnapshot,
  ArcUsageWindow,
} from "@/lib/arc-types";
import { useArcUsage } from "@/lib/data";
import { EmptyState, RefreshIcon, relativeTime } from "@/components/common";
import {
  QUOTA_TONE,
  accountTitle,
  quotaState,
  resetText,
  resourceStatusText,
  windowBarPercent,
  windowDisplayLabel,
  windowValueLabel,
} from "@/components/usage-window-format";
import { cn } from "@/lib/utils";

function WindowRow({ window, now }: { window: ArcUsageWindow; now: number }) {
  const used = windowBarPercent(window);
  const label = windowDisplayLabel(window);
  const value = windowValueLabel(window);
  const tone = QUOTA_TONE[quotaState(window)];

  // A window with neither a reported fraction nor a known limit renders its
  // amount alone — a bar there would fabricate a percentage.
  if (used === null) {
    return (
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className={cn("shrink-0 font-medium tabular-nums", tone.value)}>
          {value}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className={cn("shrink-0 font-medium tabular-nums", tone.value)}>
          {value}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", tone.bar)}
          style={{ width: `${used}%` }}
        />
      </div>
      {window.resetsAt !== null ? (
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {resetText(window.resetsAt, now)}
        </span>
      ) : null}
    </div>
  );
}

function ResourceBody({
  resource,
  now,
  onRetry,
}: {
  resource: ArcUsageResource;
  now: number;
  onRetry: () => void;
}) {
  if (resource.status === "error") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-destructive-text">
          {resourceStatusText(resource)}
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-accent/60"
        >
          Retry
        </button>
      </div>
    );
  }
  if (resource.status !== "available") {
    return (
      <span className="text-[11px] text-muted-foreground">
        {resourceStatusText(resource)}
      </span>
    );
  }

  const windows = resource.windows;
  return (
    <div className="flex flex-col gap-2.5">
      {windows.length === 0 ? (
        <span className="text-[11px] text-muted-foreground">No limit windows reported</span>
      ) : (
        windows.map((window) => <WindowRow key={window.id} window={window} now={now} />)
      )}
      {resource.stale ? (
        <span className="text-[10px] text-muted-foreground">
          Last updated {relativeTime(resource.fetchedAt ?? resource.observedAt ?? now, now)} · could not refresh
        </span>
      ) : null}
    </div>
  );
}

function ResourceCard({
  resource,
  now,
  onRetry,
}: {
  resource: ArcUsageResource;
  now: number;
  onRetry: () => void;
}) {
  const navigate = useBbNavigate();
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3.5">
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate text-[13px] font-medium">
            {accountTitle(resource)}
          </h4>
          {resource.accountEmail ? (
            <p className="truncate text-[11px] text-muted-foreground">
              {resource.accountEmail}
            </p>
          ) : null}
        </div>
        {resource.accountSourceId !== null ? (
          <button
            type="button"
            onClick={() => navigate.toPluginPanel("mission-control", { subPath: "accounts" })}
            className="shrink-0 cursor-pointer text-[11px] text-muted-foreground/70 underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Manage account
          </button>
        ) : null}
      </header>

      <ResourceBody resource={resource} now={now} onRetry={onRetry} />
    </article>
  );
}

function AgentGroup({
  title,
  resources,
  now,
  onRetry,
  empty,
}: {
  title: string;
  resources: ArcUsageResource[];
  now: number;
  onRetry: (resourceId: string) => void;
  empty: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {resources.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-3 @2xl:grid-cols-2">
          {resources.map((resource) => (
            <ResourceCard key={resource.id} resource={resource} now={now} onRetry={() => onRetry(resource.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

export function UsageLimitsPage() {
  const { data, isLoading, isFetching, error, refresh, refreshAll, refreshResource } = useArcUsage();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  // No fetch on open. A read carries Arc's last known measurement, and
  // arc-core fills a stale or missing one in the background and publishes the
  // change, which re-reads this page. The Refresh button is the only path
  // that forces a provider fetch. Usage state is separate from login state —
  // this never touches authentication flows.

  if (isLoading && data === null) {
    return (
      <div className="p-4">
        <EmptyState title="Loading usage & limits…" />
      </div>
    );
  }
  if (error !== null && data === null) {
    return (
      <div className="p-4">
        <EmptyState title="Usage & Limits could not be loaded.">
          <p className="text-[12px] text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={refresh}
            className="mt-2 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-accent/60"
          >
            Retry
          </button>
        </EmptyState>
      </div>
    );
  }

  const snapshot: ArcUsageSnapshot | null = data;
  const resources = snapshot?.resources ?? [];

  const omp = resources.filter((resource) => resource.agentIds.includes("omp"));
  const codex = resources.filter((resource) => resource.agentIds.includes("codex") && !resource.agentIds.includes("omp"));
  const claude = resources.filter(
    (resource) =>
      resource.agentIds.includes("claude-code") && !resource.agentIds.includes("omp") && !resource.agentIds.includes("codex"),
  );

  return (
    <div className="@container flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Usage &amp; Limits</h2>
          {snapshot !== null ? (
            <p className="text-[11px] tabular-nums text-muted-foreground">updated {relativeTime(snapshot.generatedAt, now)}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void refreshAll().catch(() => {})}
          aria-label="Refresh usage and limits"
          className="-mr-1 -mt-0.5 inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <RefreshIcon spinning={isFetching} className="size-3.5" />
          <span className="hidden @md:inline">Refresh</span>
        </button>
      </div>
      <AgentGroup title="OMP" resources={omp} now={now} onRetry={refreshResource} empty="No OMP usage sources." />
      <AgentGroup title="Codex" resources={codex} now={now} onRetry={refreshResource} empty="No Codex usage sources." />
      <AgentGroup title="Claude Code" resources={claude} now={now} onRetry={refreshResource} empty="No Claude Code usage sources." />
    </div>
  );
}
