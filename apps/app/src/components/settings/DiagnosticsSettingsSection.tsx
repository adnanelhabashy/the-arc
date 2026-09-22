import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section.js";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  accountDiagnostic,
  agentDiagnostic,
  buildDiagnosticsReport,
  pluginDiagnostic,
  rollupLevel,
  type DiagnosticLevel,
  type DiagnosticRow,
  type DiagnosticsReportSection,
} from "@/lib/diagnostics";
import { getSettingsSectionRoutePath } from "./settings-sections";
import { useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";
import type { ArcAgentId } from "@/hooks/queries/arc-queries";
import {
  useArcAccountsList,
  useArcAgentRepair,
  useArcAgentsList,
  useArcCurrentAgentUsage,
} from "@/hooks/queries/arc-queries";
import { usePluginList } from "@/hooks/queries/plugin-settings-queries";
import { useSystemVersion } from "@/hooks/queries/system-queries";

const LEVEL_LABEL: Record<DiagnosticLevel, string> = {
  healthy: "Healthy",
  warning: "Warning",
  error: "Error",
  "not-configured": "Not configured",
};

const LEVEL_DOT_CLASS: Record<DiagnosticLevel, string> = {
  healthy: "bg-success",
  warning: "bg-attention",
  error: "bg-destructive",
  "not-configured": "border border-muted-foreground",
};

function StatusDot({ level }: { level: DiagnosticLevel }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", LEVEL_DOT_CLASS[level])}
    />
  );
}

function DiagnosticRowView({
  row,
  action,
}: {
  row: DiagnosticRow;
  action?: ReactNode;
}) {
  return (
    <SettingsRow className="items-start gap-2.5">
      <StatusDot level={row.level} />
      <div className="min-w-0 flex-1">
        <div className="text-foreground">{row.label}</div>
        <div className="text-xs text-subtle-foreground/75">{row.detail}</div>
      </div>
      <span className="shrink-0 text-xs text-subtle-foreground/75">
        {LEVEL_LABEL[row.level]}
      </span>
      {action}
    </SettingsRow>
  );
}

interface DiagnosticsSectionGroupProps {
  title: string;
  rows: readonly DiagnosticRow[];
  renderAction?: (row: DiagnosticRow) => ReactNode;
}

function DiagnosticsSectionGroup({
  title,
  rows,
  renderAction,
}: DiagnosticsSectionGroupProps) {
  const level = rollupLevel(rows.map((row) => row.level));
  return (
    <details className="group" open>
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-sm font-medium text-foreground">
        <Icon
          name="ChevronDown"
          className="size-3.5 shrink-0 text-subtle-foreground/75 transition-transform group-open:rotate-0 -rotate-90"
        />
        <StatusDot level={level} />
        {title}
      </summary>
      <SettingsRowList>
        {rows.length === 0 ? (
          <SettingsRow className="text-xs text-subtle-foreground/75">
            Nothing to show.
          </SettingsRow>
        ) : (
          rows.map((row) => (
            <DiagnosticRowView
              key={row.id}
              row={row}
              action={renderAction?.(row)}
            />
          ))
        )}
      </SettingsRowList>
    </details>
  );
}

export interface DiagnosticsBodyProps {
  agentRows: readonly DiagnosticRow[];
  accountRows: readonly DiagnosticRow[];
  pluginRows: readonly DiagnosticRow[];
  systemRows: readonly DiagnosticRow[];
  onRecheck: () => void;
  isRechecking: boolean;
  onRepair: (agentId: ArcAgentId) => void;
  repairPendingId: ArcAgentId | null;
  repairableAgentIds: readonly ArcAgentId[];
  reportMeta: { appVersion: string; platform: string };
}

export function DiagnosticsBody({
  agentRows,
  accountRows,
  pluginRows,
  systemRows,
  onRecheck,
  isRechecking,
  onRepair,
  repairPendingId,
  repairableAgentIds,
  reportMeta,
}: DiagnosticsBodyProps) {
  const sections: DiagnosticsReportSection[] = [
    { title: "Agents", rows: agentRows },
    { title: "Accounts", rows: accountRows },
    { title: "Plugins", rows: pluginRows },
    { title: "System", rows: systemRows },
  ];
  const overall = rollupLevel(sections.flatMap((s) => s.rows.map((r) => r.level)));

  const handleCopy = () => {
    const report = buildDiagnosticsReport(sections, {
      appVersion: reportMeta.appVersion,
      platform: reportMeta.platform,
      generatedAt: Date.now(),
    });
    void copyToClipboardWithToast(report, { successMessage: "Diagnostics copied" });
  };

  return (
    <SettingsSection
      title="Diagnostics"
      description="Is Arc healthy, what's wrong, and what to do about it."
      action={
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onRecheck}>
            <Icon
              name="Loading"
              aria-hidden
              className={cn("size-3.5", isRechecking && "animate-spin")}
            />
            Recheck
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
            <Icon name="Copy" aria-hidden className="size-3.5" />
            Copy diagnostics
          </Button>
        </div>
      }
    >
      <div className="mb-3 flex items-center gap-2 text-sm">
        <StatusDot level={overall} />
        <span className="font-medium text-foreground">
          Overall status: {LEVEL_LABEL[overall]}
        </span>
      </div>
      <div className="space-y-1">
        <DiagnosticsSectionGroup
          title="Agents"
          rows={agentRows}
          renderAction={(row) =>
            repairableAgentIds.includes(row.id as ArcAgentId) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs"
                disabled={repairPendingId === row.id}
                onClick={() => onRepair(row.id as ArcAgentId)}
              >
                {repairPendingId === row.id ? "Repairing…" : "Repair"}
              </Button>
            ) : null
          }
        />
        <DiagnosticsSectionGroup title="Accounts" rows={accountRows} />
        <DiagnosticsSectionGroup
          title="Plugins"
          rows={pluginRows}
          renderAction={() => (
            <Link
              to={getSettingsSectionRoutePath("plugins")}
              className="shrink-0 text-xs text-subtle-foreground underline-offset-2 hover:underline"
            >
              Open Plugins
            </Link>
          )}
        />
        <DiagnosticsSectionGroup
          title="System"
          rows={systemRows}
          renderAction={(row) =>
            row.id === "updates" ? (
              <Link
                to={getSettingsSectionRoutePath("updates")}
                className="shrink-0 text-xs text-subtle-foreground underline-offset-2 hover:underline"
              >
                Open Updates
              </Link>
            ) : null
          }
        />
      </div>
    </SettingsSection>
  );
}

const REPAIRABLE_ACTIONS = new Set(["repair"]);

export function DiagnosticsSettingsSection() {
  const agentsQuery = useArcAgentsList();
  const accountsQuery = useArcAccountsList();
  const pluginsQuery = usePluginList({ enabled: true });
  const systemVersionQuery = useSystemVersion();
  const { desktopInfo } = useDesktopUpdateInfo();
  const repair = useArcAgentRepair();

  // Fixed, unconditional calls — not a loop — so hook order stays stable.
  const codexUsage = useArcCurrentAgentUsage({ agentId: "codex", enabled: true });
  const claudeUsage = useArcCurrentAgentUsage({
    agentId: "claude-code",
    enabled: true,
  });
  const ompUsage = useArcCurrentAgentUsage({ agentId: "omp", enabled: true });

  const exhaustedAccountKeys = new Set<string>();
  for (const usageQuery of [codexUsage, claudeUsage, ompUsage]) {
    for (const resource of usageQuery.data?.resources ?? []) {
      if (
        resource.accountKey !== null &&
        resource.windows.some((window) => window.status === "exhausted")
      ) {
        exhaustedAccountKeys.add(resource.accountKey);
      }
    }
  }

  const agents = agentsQuery.data?.agents ?? [];
  const agentRows = agents.map(agentDiagnostic);
  const repairableAgentIds = agents
    .filter((agent) =>
      agent.actions.some(
        (action) => REPAIRABLE_ACTIONS.has(action.id) && action.available,
      ),
    )
    .map((agent) => agent.id);

  const accountRows = (accountsQuery.data?.accounts ?? []).map((account) =>
    accountDiagnostic(
      account,
      account.accountKey !== null && exhaustedAccountKeys.has(account.accountKey),
    ),
  );

  const pluginRows = (pluginsQuery.data?.plugins ?? []).map(pluginDiagnostic);

  const backendHealthy = systemVersionQuery.isSuccess;
  const databaseHealthy =
    accountsQuery.isSuccess && pluginsQuery.isSuccess;
  const systemRows: DiagnosticRow[] = [
    {
      id: "backend",
      label: "Arc backend",
      level: systemVersionQuery.isError
        ? "error"
        : backendHealthy
          ? "healthy"
          : "warning",
      detail: systemVersionQuery.isError
        ? "Not reachable"
        : backendHealthy
          ? "Reachable"
          : "Checking…",
    },
    {
      id: "database",
      label: "Database",
      level: accountsQuery.isError || pluginsQuery.isError
        ? "error"
        : databaseHealthy
          ? "healthy"
          : "warning",
      detail:
        accountsQuery.isError || pluginsQuery.isError
          ? "A query failed"
          : databaseHealthy
            ? "Reachable"
            : "Checking…",
    },
    {
      id: "updates",
      label: "Updates",
      level: systemVersionQuery.data?.updateAvailable || desktopInfo?.updateAvailable
        ? "warning"
        : "healthy",
      detail:
        systemVersionQuery.data?.updateAvailable || desktopInfo?.updateAvailable
          ? "An update is available"
          : "Up to date",
    },
  ];

  const handleRecheck = () => {
    void agentsQuery.refetch();
    void accountsQuery.refetch();
    void pluginsQuery.refetch();
    void systemVersionQuery.refetch();
    void codexUsage.refetch();
    void claudeUsage.refetch();
    void ompUsage.refetch();
  };

  return (
    <DiagnosticsBody
      agentRows={agentRows}
      accountRows={accountRows}
      pluginRows={pluginRows}
      systemRows={systemRows}
      onRecheck={handleRecheck}
      isRechecking={
        agentsQuery.isFetching ||
        accountsQuery.isFetching ||
        pluginsQuery.isFetching ||
        systemVersionQuery.isFetching
      }
      onRepair={(agentId) => repair.mutate(agentId)}
      repairPendingId={repair.isPending ? (repair.variables ?? null) : null}
      repairableAgentIds={repairableAgentIds}
      reportMeta={{
        appVersion: systemVersionQuery.data?.currentVersion ?? "unknown",
        platform: desktopInfo?.platform ?? "web",
      }}
    />
  );
}
