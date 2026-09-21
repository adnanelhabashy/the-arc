// Accounts & Usage — Arc's sidebar surface over the unified usage snapshot.
//
// The same read model and the same render rules as Mission Control's Usage &
// Limits page and the in-thread Usage & Limits popup, in the compact form the
// sidebar has room for: every account Arc knows, grouped by the agent it
// serves, with the provider's own limit values. OMP provider accounts appear
// here exactly like pooled Codex and Claude accounts — Arc's snapshot already
// aggregates them — while their credentials stay owned by OMP's broker.
//
// It reads through useArcUsage, so there is no second poller: reads are cheap
// metadata plus Arc's last known measurement, arc-core's `arc-changed` signal
// re-reads this surface, and Refresh is the only path that forces a provider
// fetch.
import { useEffect, useState } from "react";
import {
  useBbNavigate,
  type ExperimentalSidebarFooterDisclosureProps,
} from "@get-bb/plugin-sdk/app";
import type { ArcUsageResource } from "@/lib/arc-types";
import { useArcUsage } from "@/lib/data";
import { relativeTime } from "@/components/common";
import {
  resourceStatusText,
  windowBarPercent,
  windowValueText,
} from "@/components/usage-window-format";
import { cn } from "@/lib/utils";

const GROUPS: { agentId: "omp" | "codex" | "claude-code"; title: string }[] = [
  { agentId: "omp", title: "OMP" },
  { agentId: "codex", title: "Codex" },
  { agentId: "claude-code", title: "Claude Code" },
];

// An account is named by what the provider gave Arc: its plan and email when
// it has them, its provider label otherwise (an OMP provider account has no
// email or plan to show).
function accountName(resource: ArcUsageResource): string {
  const detail = [resource.planLabel, resource.accountEmail]
    .filter((value) => value !== null)
    .join(" · ");
  return detail === "" ? resource.providerLabel : detail;
}

function WindowLine({ window }: { window: ArcUsageResource["windows"][number] }) {
  const value = windowValueText(window);
  const used = windowBarPercent(window);
  // Tone follows the provider's own number; a window with no reported
  // fraction or limit keeps the default tone rather than guessing one.
  const toneClass =
    used === null
      ? "text-sidebar-foreground"
      : used >= 80
        ? "text-red-400"
        : used >= 50
          ? "text-amber-400"
          : "text-sidebar-foreground";
  return (
    <div className="flex items-baseline justify-between gap-2 text-2xs">
      <span className="min-w-0 truncate text-subtle-foreground">
        {window.label}
      </span>
      <span className={cn("shrink-0 tabular-nums", toneClass)}>
        {value ?? "n/a"}
      </span>
    </div>
  );
}

function AccountRow({ resource }: { resource: ArcUsageResource }) {
  const status = resource.status === "available" ? "" : resourceStatusText(resource);
  const name = accountName(resource);
  // An account named by its provider (an OMP provider account has no plan or
  // email) would otherwise print the same label twice on one row.
  const showProvider = name !== resource.providerLabel;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate font-medium text-sidebar-foreground">
          {name}
        </span>
        {showProvider ? (
          <span className="shrink-0 text-2xs text-subtle-foreground">
            {resource.providerLabel}
          </span>
        ) : null}
      </div>
      {status !== "" ? (
        <span className="text-2xs text-subtle-foreground">{status}</span>
      ) : resource.windows.length === 0 ? (
        <span className="text-2xs text-subtle-foreground">
          No limit windows reported
        </span>
      ) : (
        <div className="flex flex-col gap-0.5 pl-2">
          {resource.windows.map((window) => (
            <WindowLine key={window.id} window={window} />
          ))}
        </div>
      )}
      {resource.stale ? (
        <span className="text-2xs text-subtle-foreground">
          Last updated{" "}
          {relativeTime(resource.fetchedAt ?? resource.observedAt ?? Date.now(), Date.now())}{" "}
          · could not refresh
        </span>
      ) : null}
    </div>
  );
}

export function AccountsUsageDisclosure({
  dismiss,
}: ExperimentalSidebarFooterDisclosureProps) {
  const { data, isLoading, isFetching, error, refresh, refreshAll } =
    useArcUsage();
  const navigate = useBbNavigate();
  const [now, setNow] = useState(() => Date.now());

  // Relative times only; nothing here fetches on a timer.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const resources = data?.resources ?? [];
  const grouped = GROUPS.map((group) => ({
    ...group,
    resources: resources.filter((resource) =>
      resource.agentIds.includes(group.agentId),
    ),
  })).filter((group) => group.resources.length > 0);

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-sidebar-border bg-sidebar p-2 text-sidebar-foreground"
      aria-label="Accounts & Usage"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs font-medium tracking-wider text-subtle-foreground uppercase">
          Accounts &amp; Usage
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refreshAll().catch(() => {})}
            aria-label="Refresh accounts and usage"
            className="-m-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-subtle-foreground transition-colors hover:bg-state-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={cn("size-3", isFetching && "animate-spin")}
            >
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Collapse accounts and usage"
            className="-m-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-subtle-foreground transition-colors hover:bg-state-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="size-3"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      {error !== null && data === null ? (
        <div className="flex flex-col gap-1">
          <span className="text-2xs text-subtle-foreground">
            Accounts &amp; Usage could not be loaded.
          </span>
          <button
            type="button"
            onClick={refresh}
            className="self-start rounded-md border border-sidebar-border px-2 py-0.5 text-2xs hover:bg-state-hover"
          >
            Retry
          </button>
        </div>
      ) : isLoading && data === null ? (
        <span className="text-2xs text-subtle-foreground">
          Loading accounts &amp; usage…
        </span>
      ) : grouped.length === 0 ? (
        <span className="text-2xs text-subtle-foreground">
          No accounts connected yet.
        </span>
      ) : (
        grouped.map((group) => (
          <section key={group.agentId} className="flex flex-col gap-1.5">
            <h3 className="text-2xs font-semibold tracking-wider text-subtle-foreground uppercase">
              {group.title}
            </h3>
            {group.resources.map((resource) => (
              <AccountRow key={resource.id} resource={resource} />
            ))}
          </section>
        ))
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs tabular-nums text-subtle-foreground">
          {data !== null ? `updated ${relativeTime(data.generatedAt, now)}` : ""}
        </span>
        <button
          type="button"
          onClick={() =>
            navigate.toPluginPanel("mission-control", { subPath: "usage" })
          }
          className="text-2xs text-subtle-foreground underline-offset-2 hover:text-sidebar-foreground hover:underline"
        >
          View all usage
        </button>
      </div>
    </div>
  );
}
