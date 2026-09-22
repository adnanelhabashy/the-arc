// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArcAgentStatus } from "@/hooks/queries/arc-queries";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";

const mocks = vi.hoisted(() => ({
  useOnboardingController: vi.fn(),
  useArcAgentsList: vi.fn(),
  useArcAgentPrepare: vi.fn(),
  useArcAgentRepair: vi.fn(),
  useArcAccountsList: vi.fn(),
}));

vi.mock("@/hooks/useOnboarding", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useOnboarding")>(
    "@/hooks/useOnboarding",
  );
  return { ...actual, useOnboardingController: mocks.useOnboardingController };
});

vi.mock("@/hooks/queries/arc-queries", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/queries/arc-queries")>(
    "@/hooks/queries/arc-queries",
  );
  return {
    ...actual,
    useArcAgentsList: mocks.useArcAgentsList,
    useArcAgentPrepare: mocks.useArcAgentPrepare,
    useArcAgentRepair: mocks.useArcAgentRepair,
    useArcAccountsList: mocks.useArcAccountsList,
  };
});

import { OnboardingOverlay } from "./OnboardingOverlay";

function agent(overrides: Partial<ArcAgentStatus> = {}): ArcAgentStatus {
  return {
    id: "codex",
    displayName: "Codex",
    runtimeId: "codex",
    providerId: "codex",
    runtime: {
      state: "ready",
      version: "1.0.0",
      compatibility: "supported",
      compatibilityReason: null,
      source: "arc-bundled",
      knownGoodVersion: null,
    },
    provider: { state: "ready" },
    account: { state: "connected" },
    overallState: "ready",
    actions: [],
    observedAt: Date.now(),
    ...overrides,
  };
}

function renderOverlay() {
  const { wrapper: QueryWrapper } = createQueryClientTestHarness();
  return render(
    <QueryWrapper>
      <MemoryRouter>
        <OnboardingOverlay />
      </MemoryRouter>
    </QueryWrapper>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OnboardingOverlay", () => {
  it("renders nothing when the gate says not to show it", () => {
    mocks.useOnboardingController.mockReturnValue({
      open: false,
      dataReady: true,
      complete: vi.fn(),
      replay: vi.fn(),
    });

    const { container } = renderOverlay();
    expect(container.firstChild).toBeNull();
  });

  it("walks welcome -> agents -> accounts -> ready, and finishing calls complete()", () => {
    const complete = vi.fn();
    mocks.useOnboardingController.mockReturnValue({
      open: true,
      dataReady: true,
      complete,
      replay: vi.fn(),
    });
    mocks.useArcAgentsList.mockReturnValue({
      data: { agents: [agent(), agent({ id: "claude-code", displayName: "Claude Code", runtime: { state: "not-prepared", version: null, compatibility: null, compatibilityReason: null, source: null, knownGoodVersion: null }, overallState: "not-prepared" })] },
      isPending: false,
    });
    mocks.useArcAgentPrepare.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.useArcAgentRepair.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.useArcAccountsList.mockReturnValue({
      data: { accounts: [], sources: [] },
      refetch: vi.fn(),
    });

    renderOverlay();

    expect(screen.getByText("Welcome to Arc Agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Get Started" }));

    expect(screen.getByText("Preparing your coding agents")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Connect accounts")).toBeTruthy();
    expect(screen.getByText("ChatGPT / Codex")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("You're ready")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create first thread" }));

    expect(complete).toHaveBeenCalledTimes(1);
  });
});
