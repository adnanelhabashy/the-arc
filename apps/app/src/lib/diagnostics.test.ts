import { describe, expect, it } from "vitest";
import type { ArcAccount, ArcAgentStatus } from "@/hooks/queries/arc-queries";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import {
  accountDiagnostic,
  agentDiagnostic,
  buildDiagnosticsReport,
  pluginDiagnostic,
  rollupLevel,
} from "./diagnostics";

function makeAgent(overrides: Partial<ArcAgentStatus> = {}): ArcAgentStatus {
  return {
    id: "codex",
    displayName: "Codex",
    runtimeId: "codex",
    providerId: "openai",
    runtime: {
      state: "ready",
      version: "1.2.3",
      compatibility: "supported",
      compatibilityReason: null,
      source: "arc-managed-download",
      knownGoodVersion: "1.2.2",
    },
    provider: { state: "ready" },
    account: { state: "connected" },
    overallState: "ready",
    actions: [],
    observedAt: 0,
    ...overrides,
  };
}

function makeAccount(overrides: Partial<ArcAccount> = {}): ArcAccount {
  return {
    id: "acct_1",
    sourceId: "pool",
    sourceKind: "pool",
    providerFamily: "openai",
    providerLabel: "ChatGPT Plus",
    accountKey: "super-secret-account-key",
    email: "user@example.com",
    planLabel: "Plus",
    authState: "connected",
    enabled: true,
    availableThrough: ["codex"],
    observedAt: 0,
    ...overrides,
  };
}

function makePlugin(overrides: Partial<PluginListItem> = {}): PluginListItem {
  return {
    id: "some-plugin",
    rootDir: "/plugins/some-plugin",
    version: "1.0.0",
    enabled: true,
    status: "running",
    statusDetail: null,
    description: null,
    name: "Some plugin",
    icon: null,
    compactIconUrl: null,
    logoUrl: null,
    logoDarkUrl: null,
    hasSettings: false,
    handlerStats: { total: 0, errored: 0 },
    services: [],
    schedules: [],
    cliCommand: null,
    capabilities: [],
    app: null,
    provenance: "builtin",
    source: "bundled",
    isOrphanedBuiltin: false,
    catalogEntryId: null,
    catalogMarketplaceName: null,
    publisherLabel: null,
    sourceDisplay: "Bundled",
    updateState: {
      outcome: null,
      detail: null,
      availableVersion: null,
      blockedVersion: null,
      blockedReasons: [],
      lastCheckAt: null,
      lastFailure: null,
    },
    ...overrides,
  } as PluginListItem;
}

describe("rollupLevel", () => {
  it("is healthy when nothing is wrong", () => {
    expect(rollupLevel(["healthy", "healthy"])).toBe("healthy");
  });

  it("does not let a not-configured row drag down an otherwise healthy system", () => {
    expect(rollupLevel(["healthy", "not-configured"])).toBe("healthy");
  });

  it("is not-configured only when everything is not-configured", () => {
    expect(rollupLevel(["not-configured", "not-configured"])).toBe(
      "not-configured",
    );
  });

  it("warning beats healthy and not-configured", () => {
    expect(rollupLevel(["healthy", "warning", "not-configured"])).toBe(
      "warning",
    );
  });

  it("error always wins", () => {
    expect(rollupLevel(["error", "warning", "healthy"])).toBe("error");
  });
});

describe("agentDiagnostic", () => {
  it("renders a healthy runtime as healthy", () => {
    const row = agentDiagnostic(makeAgent());
    expect(row.level).toBe("healthy");
    expect(row.detail).toContain("1.2.3");
  });

  it("renders a broken runtime as an error", () => {
    const row = agentDiagnostic(makeAgent({ overallState: "broken" }));
    expect(row.level).toBe("error");
  });
});

describe("accountDiagnostic", () => {
  it("renders a connected account as healthy", () => {
    const row = accountDiagnostic(makeAccount(), false);
    expect(row.level).toBe("healthy");
  });

  it("renders an authentication problem as an error, distinct from quota", () => {
    const row = accountDiagnostic(makeAccount({ authState: "expired" }), false);
    expect(row.level).toBe("error");
    expect(row.detail).toContain("Authentication");
  });

  it("treats quota exhaustion as a warning, not a runtime failure", () => {
    const row = accountDiagnostic(makeAccount({ authState: "connected" }), true);
    expect(row.level).toBe("warning");
    expect(row.detail).toBe("Quota exhausted");
  });

  it("keeps unknown distinct from healthy (UNKNOWN != ZERO)", () => {
    const row = accountDiagnostic(makeAccount({ authState: "unknown" }), false);
    expect(row.level).not.toBe("healthy");
    expect(row.level).toBe("warning");
  });
});

describe("pluginDiagnostic", () => {
  it("renders a failed plugin as an error with its name and detail", () => {
    const row = pluginDiagnostic(
      makePlugin({ id: "flaky", name: "Flaky", status: "error", statusDetail: "Crashed on load" }),
    );
    expect(row.level).toBe("error");
    expect(row.label).toBe("Flaky");
    expect(row.detail).toBe("Crashed on load");
  });

  it("treats the connect plugin's inactivity as expected, not a failure", () => {
    const row = pluginDiagnostic(
      makePlugin({ id: "connect", status: "disabled" }),
    );
    expect(row.level).toBe("not-configured");
    expect(row.detail).toBe("Inactive by design");
  });

  it("flags stale builtin provenance as an error", () => {
    const row = pluginDiagnostic(
      makePlugin({ isOrphanedBuiltin: true, status: "running" }),
    );
    expect(row.level).toBe("error");
    expect(row.detail).toContain("provenance");
  });
});

describe("buildDiagnosticsReport", () => {
  it("never includes secrets, since it only consumes pre-built rows", () => {
    const account = makeAccount();
    const row = accountDiagnostic(account, false);
    const report = buildDiagnosticsReport(
      [{ title: "Accounts", rows: [row] }],
      { appVersion: "1.0.0", platform: "mac", generatedAt: 0 },
    );
    expect(report).not.toContain(account.accountKey);
    expect(report).not.toContain(account.email);
  });

  it("includes an overall status line and each section's rows", () => {
    const report = buildDiagnosticsReport(
      [
        { title: "Agents", rows: [agentDiagnostic(makeAgent())] },
        {
          title: "Plugins",
          rows: [pluginDiagnostic(makePlugin({ status: "error" }))],
        },
      ],
      { appVersion: "1.0.0", platform: "mac", generatedAt: 0 },
    );
    expect(report).toContain("Overall status: Error");
    expect(report).toContain("Agents");
    expect(report).toContain("Plugins");
  });
});
