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
import { EmptyState, relativeTime } from "@/components/common";
import {
  percentTone,
  resetText,
  resourceStatusText,
  windowBarPercent,
  windowValueText,
} from "@/components/usage-window-format";
import { cn } from "@/lib/utils";

function WindowRow({ window, now }: { window: ArcUsageWindow; now: number }) {
  const used = windowBarPercent(window);
  const value = windowValueText(window);

  // A window with neither a reported fraction nor a known limit renders its
  // amount alone — a bar there would fabricate a percentage.
  if (used === null) {
    return (
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="truncate text-muted-foreground">{window.label}</span>
        {value !== null ? (
          <span className="font-medium tabular-nums">{value}</span>
        ) : (
          <span className="text-muted-foreground">n/a</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="truncate text-muted-foreground">{window.label}</span>
        {value !== null ? (
          <span className="font-medium tabular-nums">{value}</span>
        ) : null}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className={cn("h-full rounded-full", percentTone(used))}
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
        <span className="text-[11px] text-red-400">
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
    <div className="flex flex-col gap-2">
      {windows.length === 0 ? (
        <span className="text-[11px] text-muted-foreground">No limit windows reported</span>
      ) : (
        windows.map((window) => <WindowRow key={window.id} window={window} now={now} />)
      )}
      {resource.stale ? (
        <span className="text-[10px] text-muted-foreground/80">
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
  // An OMP provider account has no plan or email of its own, so its plan
  // label is its provider name — printing it under the same title would
  // repeat the provider twice on one card.
  const detail = [resource.planLabel, resource.accountEmail]
    .filter((value) => value !== null && value !== resource.providerLabel)
    .join(" · ");
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{resource.providerLabel}</div>
          {detail !== "" ? (
            <div className="truncate text-[11px] text-muted-foreground">
              {detail}
            </div>
          ) : null}
        </div>
        {resource.accountSourceId !== null ? (
          <button
            type="button"
            onClick={() => navigate.toPluginPanel("mission-control", { subPath: "accounts" })}
            className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Manage account
          </button>
        ) : null}
      </div>

      <ResourceBody resource={resource} now={now} onRetry={onRetry} />

      {resource.fetchedAt !== null ? (
        <span className="text-right text-[10px] tabular-nums text-muted-foreground/70">
          Updated {relativeTime(resource.fetchedAt, now)}
        </span>
      ) : null}
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
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
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
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Usage &amp; Limits</h2>
          {snapshot !== null ? (
            <p className="text-[11px] tabular-nums text-muted-foreground">updated {relativeTime(snapshot.generatedAt, now)}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void refreshAll().catch(() => {})}
          aria-label="Refresh usage and limits"
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={cn("size-3.5", isFetching && "animate-spin")}
          >
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
        </button>
      </div>
      <AgentGroup title="OMP" resources={omp} now={now} onRetry={refreshResource} empty="No OMP usage sources." />
      <AgentGroup title="Codex" resources={codex} now={now} onRetry={refreshResource} empty="No Codex usage sources." />
      <AgentGroup title="Claude Code" resources={claude} now={now} onRetry={refreshResource} empty="No Claude Code usage sources." />
    </div>
  );
}
