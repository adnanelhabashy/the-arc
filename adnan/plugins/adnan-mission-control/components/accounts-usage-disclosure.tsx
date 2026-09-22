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
import { RefreshIcon, relativeTime } from "@/components/common";
import { Icon } from "@/components/ui/icon";
import {
  EXHAUSTED_LABEL,
  QUOTA_TONE,
  quotaState,
  resourceStatusText,
  windowDisplayLabel,
  windowValueLabel,
} from "@/components/usage-window-format";
import { cn } from "@/lib/utils";

const GROUPS: { agentId: "omp" | "codex" | "claude-code"; title: string }[] = [
  { agentId: "omp", title: "OMP" },
  { agentId: "codex", title: "Codex" },
  { agentId: "claude-code", title: "Claude Code" },
];

// An account is named by what the provider gave Arc: its plan and email when
// it has them, its provider label otherwise (an OMP provider account has no
// email or plan to show). The plan is capitalised because providers report it
// lowercase, and the page titles the same account from the same value.
function accountName(resource: ArcUsageResource): string {
  const plan = resource.planLabel === null ? null : resource.planLabel.trim();
  const titled =
    plan === null || plan === "" ? null : plan.charAt(0).toUpperCase() + plan.slice(1);
  const detail = [titled, resource.accountEmail]
    .filter((value) => value !== null)
    .join(" · ");
  return detail === "" ? resource.providerLabel : detail;
}

function WindowLine({ window }: { window: ArcUsageResource["windows"][number] }) {
  const state = quotaState(window);
  // The sidebar has room for one word where the page can afford the exact
  // number: a spent window says so instead of printing "0 remaining".
  const value = state === "exhausted" ? EXHAUSTED_LABEL : windowValueLabel(window);
  return (
    <div className="flex items-baseline justify-between gap-2 text-2xs leading-3">
      <span className="min-w-0 truncate text-subtle-foreground">
        {windowDisplayLabel(window)}
      </span>
      <span className={cn("shrink-0 tabular-nums", QUOTA_TONE[state].value)}>
        {value}
      </span>
    </div>
  );
}

function AccountRow({ resource, now }: { resource: ArcUsageResource; now: number }) {
  const status = resource.status === "available" ? "" : resourceStatusText(resource);
  const name = accountName(resource);
  // An account named by its provider (an OMP provider account has no plan or
  // email) would otherwise print the same label twice on one row.
  const showProvider = name !== resource.providerLabel;
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between gap-2 text-xs leading-tight">
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
        <div className="flex flex-col">
          {resource.windows.map((window) => (
            <WindowLine key={window.id} window={window} />
          ))}
        </div>
      )}
      {resource.stale ? (
        <span className="text-2xs text-subtle-foreground">
          Last updated{" "}
          {relativeTime(resource.fetchedAt ?? resource.observedAt ?? now, now)}{" "}
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
    <div className="flex flex-col gap-1 p-2" aria-label="Accounts & Usage">
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs font-medium tracking-wider text-subtle-foreground uppercase">
          Accounts &amp; Usage
        </span>
        <div className="flex items-center gap-0.5">
          {data !== null ? (
            <span className="mr-0.5 min-w-0 truncate text-2xs tabular-nums text-subtle-foreground">
              {relativeTime(data.generatedAt, now)}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void refreshAll().catch(() => {})}
            aria-label="Refresh accounts and usage"
            className="-m-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-subtle-foreground transition-colors hover:bg-state-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshIcon spinning={isFetching} className="size-3" />
          </button>
          <button
            type="button"
            onClick={() =>
              navigate.toPluginPanel("mission-control", { subPath: "usage" })
            }
            aria-label="View all usage"
            title="View all usage"
            className="-m-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-subtle-foreground transition-colors hover:bg-state-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon name="ExternalLink" className="size-3" />
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
          <section key={group.agentId} className="flex flex-col gap-1">
            <h3 className="text-2xs leading-3 font-semibold tracking-wider text-subtle-foreground uppercase">
              {group.title}
            </h3>
            {group.resources.map((resource) => (
              <AccountRow key={resource.id} resource={resource} now={now} />
            ))}
          </section>
        ))
      )}
    </div>
  );
}
