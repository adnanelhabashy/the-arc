import type {
  ArcAccount,
  ArcAccountAuthState,
  ArcAgentOverallState,
  ArcAgentStatus,
} from "@/hooks/queries/arc-queries";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";

// Registry-only plugin with no sources in this checkout: expected to stay
// inactive here, not a failure (see docs/plugin-provenance.md).
const EXPECTED_INACTIVE_PLUGIN_IDS = new Set(["connect"]);

export type DiagnosticLevel = "healthy" | "warning" | "error" | "not-configured";

export interface DiagnosticRow {
  id: string;
  label: string;
  level: DiagnosticLevel;
  detail: string;
}

export function rollupLevel(
  levels: readonly DiagnosticLevel[],
): DiagnosticLevel {
  if (levels.length === 0) return "not-configured";
  if (levels.some((level) => level === "error")) return "error";
  if (levels.some((level) => level === "warning")) return "warning";
  if (levels.every((level) => level === "not-configured")) {
    return "not-configured";
  }
  return "healthy";
}

const AGENT_STATE_LABEL: Record<
  ArcAgentOverallState,
  { level: DiagnosticLevel; detail: string }
> = {
  "not-prepared": { level: "not-configured", detail: "Not installed" },
  preparing: { level: "warning", detail: "Preparing" },
  "runtime-ready": { level: "warning", detail: "Runtime ready, no provider" },
  "account-required": { level: "warning", detail: "Needs an account" },
  ready: { level: "healthy", detail: "Ready" },
  broken: { level: "error", detail: "Broken" },
  unsupported: { level: "not-configured", detail: "Unsupported on this machine" },
  unavailable: { level: "error", detail: "Unavailable" },
};

export function agentDiagnostic(agent: ArcAgentStatus): DiagnosticRow {
  const mapped = AGENT_STATE_LABEL[agent.overallState];
  const version = agent.runtime.version ?? "not installed";
  return {
    id: agent.id,
    label: agent.displayName,
    level: mapped.level,
    detail: `${mapped.detail} (${version})`,
  };
}

const ACCOUNT_AUTH_LABEL: Record<
  ArcAccountAuthState,
  { level: DiagnosticLevel; detail: string }
> = {
  connected: { level: "healthy", detail: "Connected" },
  expired: { level: "error", detail: "Authentication problem (expired)" },
  disabled: { level: "not-configured", detail: "Disabled" },
  error: { level: "error", detail: "Authentication problem" },
  // UNKNOWN != ZERO: an account we can't currently read is a warning, not a
  // clean bill of health and not an outright failure.
  unknown: { level: "warning", detail: "Usage unavailable" },
};

export function accountDiagnostic(
  account: ArcAccount,
  quotaExhausted: boolean,
): DiagnosticRow {
  const mapped = ACCOUNT_AUTH_LABEL[account.authState];
  const quotaNote =
    quotaExhausted && account.authState === "connected"
      ? { level: "warning" as const, detail: "Quota exhausted" }
      : null;
  return {
    id: account.id,
    label: account.providerLabel,
    level: quotaNote?.level ?? mapped.level,
    detail: quotaNote?.detail ?? mapped.detail,
  };
}

const PLUGIN_STATUS_LABEL: Record<
  PluginListItem["status"],
  { level: DiagnosticLevel; detail: string }
> = {
  running: { level: "healthy", detail: "Running" },
  starting: { level: "warning", detail: "Starting" },
  degraded: { level: "warning", detail: "Degraded" },
  "needs-configuration": { level: "warning", detail: "Needs configuration" },
  disabled: { level: "not-configured", detail: "Disabled" },
  error: { level: "error", detail: "Failed" },
  incompatible: { level: "error", detail: "Incompatible" },
  missing: { level: "error", detail: "Missing" },
};

export function pluginDiagnostic(plugin: PluginListItem): DiagnosticRow {
  if (
    EXPECTED_INACTIVE_PLUGIN_IDS.has(plugin.id) &&
    (plugin.status === "disabled" || plugin.status === "missing")
  ) {
    return {
      id: plugin.id,
      label: plugin.name ?? plugin.id,
      level: "not-configured",
      detail: "Inactive by design",
    };
  }
  if (plugin.isOrphanedBuiltin) {
    return {
      id: plugin.id,
      label: plugin.name ?? plugin.id,
      level: "error",
      detail: "Stale provenance: not resolved from this app's build",
    };
  }
  const mapped = PLUGIN_STATUS_LABEL[plugin.status];
  return {
    id: plugin.id,
    label: plugin.name ?? plugin.id,
    level: mapped.level,
    detail: plugin.statusDetail ?? mapped.detail,
  };
}

export interface DiagnosticsReportSection {
  title: string;
  rows: readonly DiagnosticRow[];
}

export interface DiagnosticsReportMeta {
  appVersion: string;
  platform: string;
  generatedAt: number;
}

const LEVEL_REPORT_LABEL: Record<DiagnosticLevel, string> = {
  healthy: "Healthy",
  warning: "Warning",
  error: "Error",
  "not-configured": "Not configured",
};

// Consumes only already-computed rows (label/level/detail strings this
// module builds) so a secret can never reach the exported report even if one
// showed up on a source object — there is no code path from raw account/
// plugin fields into this function.
export function buildDiagnosticsReport(
  sections: readonly DiagnosticsReportSection[],
  meta: DiagnosticsReportMeta,
): string {
  const overall = rollupLevel(
    sections.flatMap((section) => section.rows.map((row) => row.level)),
  );
  const lines = [
    "Arc diagnostics report",
    `Generated: ${new Date(meta.generatedAt).toISOString()}`,
    `Arc version: ${meta.appVersion}`,
    `Platform: ${meta.platform}`,
    `Overall status: ${LEVEL_REPORT_LABEL[overall]}`,
    "",
  ];
  for (const section of sections) {
    lines.push(section.title);
    if (section.rows.length === 0) {
      lines.push("  (none)");
    }
    for (const row of section.rows) {
      lines.push(`  ${row.label}: ${LEVEL_REPORT_LABEL[row.level]} — ${row.detail}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
