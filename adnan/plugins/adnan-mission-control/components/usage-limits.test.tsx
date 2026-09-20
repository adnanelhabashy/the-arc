// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArcUsageResource, ArcUsageWindow } from "@/lib/arc-types";

const mocks = vi.hoisted(() => ({
  useArcUsage: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  useArcUsage: mocks.useArcUsage,
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => ({ toPluginPanel: vi.fn(), toThread: vi.fn(), toUrl: vi.fn() }),
}));

import { UsageLimitsPage } from "./usage-limits";

function percentWindow(overrides: Partial<ArcUsageWindow> = {}): ArcUsageWindow {
  return {
    id: "w1",
    label: "Requests",
    kind: "daily",
    status: "ok",
    usedPercent: 50,
    remainingPercent: 50,
    usedAmount: null,
    limitAmount: null,
    remainingAmount: null,
    unit: "percent",
    resetsAt: null,
    observedAt: null,
    source: "pool",
    ...overrides,
  };
}

function amountWindow(overrides: Partial<ArcUsageWindow> = {}): ArcUsageWindow {
  return {
    id: "w2",
    label: "Credit",
    kind: "custom",
    status: null,
    usedPercent: null,
    remainingPercent: null,
    usedAmount: null,
    limitAmount: null,
    remainingAmount: 7.32,
    unit: "credits",
    resetsAt: null,
    observedAt: null,
    source: "pool",
    ...overrides,
  };
}

function resource(overrides: Partial<ArcUsageResource> = {}): ArcUsageResource {
  return {
    id: "pool:openai:1",
    sourceKind: "pool",
    accountKey: null,
    accountSourceId: null,
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountEmail: null,
    planLabel: "Plus",
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

function renderUsage(resources: ArcUsageResource[]) {
  mocks.useArcUsage.mockReturnValue({
    data: { generatedAt: Date.now(), resources, sources: [] },
    isLoading: false,
    isFetching: false,
    error: null,
    refresh: vi.fn(),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    refreshResource: vi.fn(),
  });
  render(<UsageLimitsPage />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UsageLimitsPage", () => {
  it("renders not-exposed as 'not exposed by provider' and never 0%", () => {
    renderUsage([resource({ status: "unavailable", unavailableReason: "not-exposed" })]);
    expect(screen.getByText("Usage limits not exposed by provider")).toBeTruthy();
    expect(screen.queryByText(/0%/)).toBeNull();
  });

  it("keeps last-good values with a stale notice", () => {
    renderUsage([resource({ stale: true, windows: [percentWindow({ usedPercent: 50, remainingPercent: 50 })] })]);
    expect(screen.getByText("50% remaining")).toBeTruthy();
    expect(screen.getByText(/could not refresh/)).toBeTruthy();
  });

  it("renders an amount window as an amount, not a percent", () => {
    renderUsage([resource({ windows: [amountWindow()] })]);
    expect(screen.getByText("7.32 credits remaining")).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("derives a bar and reset line for an amount window with a known limit (Kimi shape)", () => {
    renderUsage([
      resource({
        windows: [
          amountWindow({
            id: "kimi-weekly",
            label: "Weekly limit",
            kind: "weekly",
            usedAmount: 88,
            limitAmount: 100,
            remainingAmount: 12,
            unit: "unknown",
            resetsAt: Date.now() + 60 * 60 * 1000,
          }),
        ],
      }),
    ]);
    expect(screen.getByText("12 remaining")).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByText(/Resets in 1h/)).toBeTruthy();
  });

  it("renders an error resource with an inline Retry", () => {
    renderUsage([resource({ status: "error", message: "boom" })]);
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps other cards when one source fails", () => {
    renderUsage([
      resource({ id: "bad", status: "error", message: "boom" }),
      resource({ id: "good", windows: [percentWindow({ usedPercent: 20, remainingPercent: 80 })] }),
    ]);
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByText("80% remaining")).toBeTruthy();
  });

  it("fetches real usage on mount (the snapshot alone never has windows)", () => {
    const refreshAll = vi.fn().mockResolvedValue(undefined);
    mocks.useArcUsage.mockReturnValue({
      data: { generatedAt: Date.now(), resources: [], sources: [] },
      isLoading: false,
      isFetching: false,
      error: null,
      refresh: vi.fn(),
      refreshAll,
      refreshResource: vi.fn(),
    });
    render(<UsageLimitsPage />);
    expect(refreshAll).toHaveBeenCalledTimes(1);
  });

  it("the Refresh button re-runs the full refresh", () => {
    const refreshAll = vi.fn().mockResolvedValue(undefined);
    mocks.useArcUsage.mockReturnValue({
      data: { generatedAt: Date.now(), resources: [], sources: [] },
      isLoading: false,
      isFetching: false,
      error: null,
      refresh: vi.fn(),
      refreshAll,
      refreshResource: vi.fn(),
    });
    render(<UsageLimitsPage />);
    refreshAll.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Refresh usage and limits" }));
    expect(refreshAll).toHaveBeenCalledTimes(1);
  });

  it("renders a provider-reported resource even when its account cannot be identified", () => {
    // accountKey null means "no trustworthy canonical identity": the
    // resource must still appear with its provider-reported usage.
    renderUsage([
      resource({
        id: "omp:opencode-go:1",
        sourceKind: "omp",
        accountKey: null,
        providerLabel: "OpenCode Go",
        agentIds: ["omp"],
        windows: [percentWindow({ usedPercent: 73, remainingPercent: 27 })],
        status: "available",
        fetchedAt: Date.now(),
      }),
    ]);
    expect(screen.getByText("OpenCode Go")).toBeTruthy();
    expect(screen.getByText("27% remaining")).toBeTruthy();
  });

  it("says not-exposed rather than 0% for providers without usage limits", () => {
    renderUsage([
      resource({
        status: "unavailable",
        unavailableReason: "not-exposed",
        windows: [],
      }),
    ]);
    expect(screen.getByText("Usage limits not exposed by provider")).toBeTruthy();
    expect(screen.queryByText(/% remaining/)).toBeNull();
  });
});
