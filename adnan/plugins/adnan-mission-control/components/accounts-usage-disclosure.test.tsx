// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ArcUsageResource, ArcUsageWindow } from "@/lib/arc-types";

const mocks = vi.hoisted(() => ({
  useArcUsage: vi.fn(),
  toPluginPanel: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  useArcUsage: mocks.useArcUsage,
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => ({
    toPluginPanel: mocks.toPluginPanel,
    toThread: vi.fn(),
    toUrl: vi.fn(),
  }),
}));

import { AccountsUsageDisclosure } from "./accounts-usage-disclosure";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");

function window(overrides: Partial<ArcUsageWindow> = {}): ArcUsageWindow {
  return {
    id: "w1",
    label: "Weekly limit",
    kind: "weekly",
    status: "ok",
    usedPercent: null,
    remainingPercent: null,
    usedAmount: null,
    limitAmount: null,
    remainingAmount: null,
    unit: "unknown",
    resetsAt: null,
    observedAt: null,
    source: null,
    ...overrides,
  };
}

function resource(overrides: Partial<ArcUsageResource> = {}): ArcUsageResource {
  return {
    id: "pool:openai:1",
    sourceKind: "pool",
    accountKey: "openai:chatgpt:1",
    accountSourceId: "1",
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountEmail: "plus@example.com",
    planLabel: "plus",
    modelLabel: null,
    agentIds: ["codex"],
    windows: [],
    observedAt: null,
    fetchedAt: NOW,
    stale: false,
    status: "available",
    unavailableReason: null,
    credentialDisabled: false,
    message: null,
    sources: ["pool"],
    ...overrides,
  };
}

function kimi(): ArcUsageResource {
  return resource({
    id: "omp:kimi-code:omp:kimi-code:2",
    sourceKind: "omp",
    accountKey: "omp:kimi-code:credential-2",
    accountSourceId: "omp:kimi-code:2",
    providerFamily: "kimi-code",
    providerLabel: "Kimi Code",
    accountEmail: null,
    planLabel: null,
    agentIds: ["omp"],
    sources: ["omp"],
    windows: [
      window({
        id: "kimi-weekly",
        label: "Weekly limit",
        status: "exhausted",
        usedAmount: 100,
        limitAmount: 100,
        remainingAmount: 0,
      }),
      window({
        id: "kimi-5h",
        label: "5h limit",
        kind: "five-hour",
        usedAmount: 0,
        limitAmount: 100,
        remainingAmount: 100,
      }),
    ],
  });
}

function openCode(): ArcUsageResource {
  return resource({
    id: "omp:opencode-go:omp:opencode-go:1",
    sourceKind: "omp",
    accountKey: null,
    accountSourceId: "omp:opencode-go:1",
    providerFamily: "opencode-go",
    providerLabel: "OpenCode Go",
    accountEmail: null,
    planLabel: null,
    agentIds: ["omp"],
    sources: ["omp"],
    windows: [
      window({
        id: "rolling-5h",
        label: "5 Hour limit",
        kind: "five-hour",
        usedPercent: 11,
        remainingPercent: 89,
        unit: "percent",
      }),
    ],
  });
}

function renderDisclosure(resources: ArcUsageResource[]) {
  const refreshAll = vi.fn().mockResolvedValue(undefined);
  mocks.useArcUsage.mockReturnValue({
    data: { generatedAt: NOW, resources, sources: [] },
    isLoading: false,
    isFetching: false,
    error: null,
    refresh: vi.fn(),
    refreshAll,
    refreshResource: vi.fn(),
  });
  render(<AccountsUsageDisclosure dismiss={vi.fn()} />);
  return { refreshAll };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows every account Arc knows, grouped by the agent it serves", () => {
  renderDisclosure([
    resource({ id: "pool:openai:1", planLabel: "plus", accountEmail: "plus@example.com" }),
    resource({
      id: "pool:openai:2",
      accountKey: "openai:chatgpt:2",
      accountSourceId: "2",
      planLabel: "team",
      accountEmail: "team@example.com",
    }),
    resource({
      id: "pool:anthropic:1",
      accountKey: "anthropic:account:1",
      accountSourceId: "3",
      providerFamily: "anthropic",
      providerLabel: "Claude",
      planLabel: "pro",
      accountEmail: "claude@example.com",
      agentIds: ["claude-code"],
      sources: ["pool"],
    }),
    kimi(),
    openCode(),
  ]);

  expect(screen.getByText("OMP")).toBeTruthy();
  expect(screen.getByText("Codex")).toBeTruthy();
  expect(screen.getByText("Claude Code")).toBeTruthy();
  expect(screen.getByText("Plus · plus@example.com")).toBeTruthy();
  expect(screen.getByText("Team · team@example.com")).toBeTruthy();
  expect(screen.getByText("Pro · claude@example.com")).toBeTruthy();
  // OMP provider accounts have no plan or email to show, so the account is
  // named by the provider itself — once, not twice on the same row.
  expect(screen.getAllByText("Kimi Code")).toHaveLength(1);
  expect(screen.getAllByText("OpenCode Go")).toHaveLength(1);
});

it("says a spent window is exhausted instead of printing its zero", () => {
  renderDisclosure([kimi(), openCode()]);

  // The provider's own labels are normalised, so both providers' 5h window
  // reads the same, and a spent window says so in the sidebar's short form.
  expect(screen.getByText("Weekly")).toBeTruthy();
  expect(screen.getByText("Exhausted")).toBeTruthy();
  expect(screen.queryByText("0 remaining")).toBeNull();
  expect(screen.getByText("100 remaining")).toBeTruthy();
  // Both providers' five-hour window now reads "5h".
  expect(screen.getAllByText("5h")).toHaveLength(2);
  expect(screen.getByText("89% remaining")).toBeTruthy();
});

it("keeps a healthy window's value in the plain text tier", () => {
  renderDisclosure([openCode()]);

  expect(screen.getByText("89% remaining").className).not.toContain("text-warning");
  expect(screen.getByText("89% remaining").className).not.toContain("text-destructive");
});

it("never shows a fabricated zero for a resource that reported nothing", () => {
  renderDisclosure([
    resource({
      status: "unavailable",
      unavailableReason: "not-exposed",
      windows: [],
    }),
  ]);

  expect(screen.getByText("Usage limits not exposed by provider")).toBeTruthy();
  expect(screen.queryByText(/0 remaining/)).toBeNull();
  expect(screen.queryByText(/% remaining/)).toBeNull();
});

it("keeps the last good reading and says so when a refresh failed", () => {
  renderDisclosure([
    resource({
      stale: true,
      windows: [window({ usedPercent: 50, remainingPercent: 50, unit: "percent" })],
    }),
  ]);

  expect(screen.getByText("50% remaining")).toBeTruthy();
  expect(screen.getByText(/could not refresh/)).toBeTruthy();
});

it("forces a provider fetch only through Refresh, and links to the full page", () => {
  const { refreshAll } = renderDisclosure([kimi()]);

  fireEvent.click(
    screen.getByRole("button", { name: "Refresh accounts and usage" }),
  );
  expect(refreshAll).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "View all usage" }));
  expect(mocks.toPluginPanel).toHaveBeenCalledWith("mission-control", {
    subPath: "usage",
  });
});

it("reports an empty account list instead of an empty panel", () => {
  renderDisclosure([]);

  expect(screen.getByText("No accounts connected yet.")).toBeTruthy();
});
