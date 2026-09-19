// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArcAgentStatus } from "@/lib/arc-types";

const mocks = vi.hoisted(() => ({
  useArcAgents: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  useArcAgents: mocks.useArcAgents,
}));

import { AgentsPage } from "./agents";

type RuntimeState = ArcAgentStatus["runtime"]["state"];
type AccountState = ArcAgentStatus["account"]["state"];
type ProviderState = ArcAgentStatus["provider"]["state"];
type OverallState = ArcAgentStatus["overallState"];

function agent(
  id: ArcAgentStatus["id"],
  displayName: string,
  runtimeState: RuntimeState = "ready",
  accountState: AccountState = "connected",
  providerState: ProviderState = "ready",
  overallState: OverallState = "ready",
): ArcAgentStatus {
  return {
    id,
    displayName,
    runtimeId: id,
    providerId: id === "omp" ? "acp-omp" : id,
    runtime: {
      state: runtimeState,
      version: "18.2.6",
      compatibility: runtimeState === "unsupported" ? "blocked" : runtimeState === "ready-with-warning" ? "untested" : "supported",
      compatibilityReason: null,
      source: "arc-bundled",
    },
    provider: { state: providerState },
    account: { state: accountState },
    overallState,
    actions:
      runtimeState === "not-prepared"
        ? [{ id: "prepare", available: true }]
        : runtimeState === "broken"
          ? [{ id: "repair", available: true }]
          : [],
    observedAt: 1,
  };
}

function renderWith(agents: ArcAgentStatus[]) {
  mocks.useArcAgents.mockReturnValue({
    agents,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    prepare: vi.fn().mockResolvedValue(agents[0]),
    repair: vi.fn().mockResolvedValue(agents[0]),
  });
  render(<AgentsPage />);
}

function chipClass(label: string): string {
  return screen.getByText(label).className;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentsPage", () => {
  it("renders three cards in catalog order (OMP, Codex, Claude Code)", () => {
    renderWith([
      agent("omp", "OMP"),
      agent("codex", "Codex"),
      agent("claude-code", "Claude Code"),
    ]);
    const headings = screen.getAllByRole("heading", { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["OMP", "Codex", "Claude Code"]);
  });

  it("renders a green Ready chip for a ready agent", () => {
    renderWith([agent("codex", "Codex", "ready", "connected", "ready", "ready")]);
    expect(chipClass("Ready")).toContain("emerald");
  });

  it("renders Setup required for a not-prepared agent", () => {
    renderWith([agent("omp", "OMP", "not-prepared", "not-connected", "ready", "not-prepared")]);
    expect(screen.getByText("Setup required")).toBeTruthy();
  });

  it("renders Needs repair for a broken agent", () => {
    renderWith([agent("codex", "Codex", "broken", "connected", "ready", "broken")]);
    expect(screen.getByText("Needs repair")).toBeTruthy();
  });

  it("renders Unsupported version for an unsupported agent", () => {
    renderWith([agent("codex", "Codex", "unsupported", "connected", "ready", "unsupported")]);
    expect(screen.getAllByText("Unsupported version").length).toBeGreaterThan(0);
  });

  it("renders Ready · Untested version for a ready-with-warning agent", () => {
    renderWith([agent("claude-code", "Claude Code", "ready-with-warning", "connected", "ready", "ready")]);
    expect(screen.getByText("Ready · Untested version")).toBeTruthy();
  });

  it("shows a Set Up button only for a not-prepared agent", () => {
    renderWith([
      agent("omp", "OMP", "not-prepared", "not-connected", "ready", "not-prepared"),
      agent("codex", "Codex"),
    ]);
    expect(screen.getByText("Set Up OMP")).toBeTruthy();
    expect(screen.queryByText("Set Up Codex")).toBeNull();
  });

  it("shows a Repair button for a broken agent", () => {
    renderWith([agent("claude-code", "Claude Code", "broken", "connected", "ready", "broken")]);
    expect(screen.getByText("Repair")).toBeTruthy();
  });

  it("never renders green when the provider state is unknown", () => {
    renderWith([agent("codex", "Codex", "ready", "connected", "unknown", "ready")]);
    expect(chipClass("Ready")).not.toContain("emerald");
  });
});
