// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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

  it("renders an error resource with an inline Retry", () => {
    renderUsage([resource({ status: "error", message: "boom" })]);
    expect(screen.getByText("Usage temporarily unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps other cards when one source fails", () => {
    renderUsage([
      resource({ id: "bad", status: "error", message: "boom" }),
      resource({ id: "good", windows: [percentWindow({ usedPercent: 20, remainingPercent: 80 })] }),
    ]);
    expect(screen.getByText("Usage temporarily unavailable")).toBeTruthy();
    expect(screen.getByText("80% remaining")).toBeTruthy();
  });
});
