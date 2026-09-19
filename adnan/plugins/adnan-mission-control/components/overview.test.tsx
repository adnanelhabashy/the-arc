// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArcAccount, ArcAgentStatus, ArcUsageResource } from "@/lib/arc-types";

const mocks = vi.hoisted(() => ({
  useTree: vi.fn(),
  useMission: vi.fn(),
  useArcStatus: vi.fn(),
  useArcAgents: vi.fn(),
  useArcAccounts: vi.fn(),
  useArcUsage: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  useTree: mocks.useTree,
  useMission: mocks.useMission,
  useArcStatus: mocks.useArcStatus,
  useArcAgents: mocks.useArcAgents,
  useArcAccounts: mocks.useArcAccounts,
  useArcUsage: mocks.useArcUsage,
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: vi.fn() }),
}));

import { OverviewPage } from "./overview";

function agent(overallState: ArcAgentStatus["overallState"]): ArcAgentStatus {
  return {
    id: "codex",
    displayName: "Codex",
    runtimeId: "codex",
    providerId: "codex",
    runtime: { state: "ready", version: "18.2.6", compatibility: "supported", compatibilityReason: null, source: "arc-bundled" },
    provider: { state: "ready" },
    account: { state: "connected" },
    overallState,
    actions: [],
    observedAt: 1,
  };
}

function account(overrides: Partial<ArcAccount> = {}): ArcAccount {
  return {
    id: "pool:1",
    sourceId: "1",
    sourceKind: "pool",
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountKey: null,
    email: null,
    planLabel: null,
    authState: "connected",
    enabled: true,
    availableThrough: ["codex"],
    observedAt: 1,
    ...overrides,
  };
}

function usageResource(overrides: Partial<ArcUsageResource> = {}): ArcUsageResource {
  return {
    id: "r1",
    sourceKind: "pool",
    accountKey: null,
    accountSourceId: null,
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountEmail: null,
    planLabel: null,
    modelLabel: null,
    agentIds: ["codex"],
    windows: [],
    observedAt: null,
    fetchedAt: Date.now(),
    stale: false,
    status: "available",
    unavailableReason: null,
    credentialDisabled: false,
    message: null,
    sources: ["pool"],
    ...overrides,
  };
}

type Overrides = {
  status?: { arcAvailable: boolean; reason: string | null };
  agents?: ArcAgentStatus[];
  accounts?: ArcAccount[];
  usage?: ArcUsageResource[];
};

function renderOverview(overrides: Overrides = {}) {
  mocks.useTree.mockReturnValue({ data: null, isLoading: false, error: null, refresh: vi.fn() });
  mocks.useMission.mockReturnValue({ state: null, isLoading: false, setState: vi.fn() });
  mocks.useArcStatus.mockReturnValue({ status: overrides.status ?? { arcAvailable: true, reason: null }, isLoading: false, error: null });
  mocks.useArcAgents.mockReturnValue({
    agents: overrides.agents ?? [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    prepare: vi.fn(),
    repair: vi.fn(),
  });
  mocks.useArcAccounts.mockReturnValue({
    accounts: overrides.accounts ?? [],
    sources: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    setEnabled: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
  });
  mocks.useArcUsage.mockReturnValue({
    data: overrides.usage ? { generatedAt: Date.now(), resources: overrides.usage, sources: [] } : null,
    isLoading: false,
    isFetching: false,
    error: null,
    refresh: vi.fn(),
    refreshResource: vi.fn(),
  });
  render(<OverviewPage />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OverviewPage Arc summary", () => {
  it("reports Arc services unavailable when arcAvailable is false", () => {
    renderOverview({ status: { arcAvailable: false, reason: "not started by Arc" } });
    expect(screen.getByText("Arc services unavailable on this server.")).toBeTruthy();
  });

  it("counts agents, connected accounts, and stale/error usage sources", () => {
    renderOverview({
      agents: [agent("ready"), agent("ready"), agent("not-prepared")],
      accounts: [account({ authState: "connected", enabled: true }), account({ authState: "expired", enabled: true })],
      usage: [usageResource({ id: "stale", stale: true }), usageResource({ id: "error", status: "error", message: "boom" })],
    });

    expect(screen.getByText(/Ready 2/)).toBeTruthy();
    expect(screen.getByText(/Setup required 1/)).toBeTruthy();
    expect(screen.getByText(/Accounts 1 connected/)).toBeTruthy();
    expect(screen.getByText(/1 stale · 1 error/)).toBeTruthy();
  });
});
