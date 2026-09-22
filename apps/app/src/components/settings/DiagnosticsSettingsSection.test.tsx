// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: toastMocks,
}));

import type { DiagnosticRow } from "@/lib/diagnostics";
import { DiagnosticsBody, type DiagnosticsBodyProps } from "./DiagnosticsSettingsSection";

function installClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

afterEach(() => {
  cleanup();
  toastMocks.error.mockReset();
  toastMocks.success.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

const HEALTHY_AGENT: DiagnosticRow = {
  id: "codex",
  label: "Codex",
  level: "healthy",
  detail: "Ready (1.2.3)",
};

function renderBody(overrides: Partial<DiagnosticsBodyProps> = {}) {
  const props: DiagnosticsBodyProps = {
    agentRows: [HEALTHY_AGENT],
    accountRows: [],
    pluginRows: [],
    systemRows: [],
    onRecheck: vi.fn(),
    isRechecking: false,
    onRepair: vi.fn(),
    repairPendingId: null,
    repairableAgentIds: [],
    reportMeta: { appVersion: "1.0.0", platform: "mac" },
    ...overrides,
  };
  render(
    <MemoryRouter>
      <DiagnosticsBody {...props} />
    </MemoryRouter>,
  );
  return props;
}

describe("DiagnosticsBody", () => {
  it("renders a healthy overall state when every row is healthy", () => {
    renderBody({ agentRows: [HEALTHY_AGENT] });
    expect(screen.getByText("Overall status: Healthy")).toBeDefined();
    expect(screen.getByText("Codex")).toBeDefined();
  });

  it("renders a runtime failure as an error and shows a Repair action", () => {
    renderBody({
      agentRows: [{ id: "codex", label: "Codex", level: "error", detail: "Broken (1.2.3)" }],
      repairableAgentIds: ["codex"],
    });
    expect(screen.getByText("Overall status: Error")).toBeDefined();
    expect(screen.getByRole("button", { name: "Repair" })).toBeDefined();
  });

  it("renders an account authentication failure distinctly from quota exhaustion", () => {
    renderBody({
      accountRows: [
        { id: "a1", label: "ChatGPT Plus", level: "error", detail: "Authentication problem" },
        { id: "a2", label: "Claude", level: "warning", detail: "Quota exhausted" },
      ],
    });
    expect(screen.getByText("Authentication problem")).toBeDefined();
    expect(screen.getByText("Quota exhausted")).toBeDefined();
    // An authentication error still wins the overall rollup over a mere quota warning.
    expect(screen.getByText("Overall status: Error")).toBeDefined();
  });

  it("keeps quota exhaustion at warning, not error, when nothing else is wrong", () => {
    renderBody({
      agentRows: [],
      accountRows: [
        { id: "a2", label: "Claude", level: "warning", detail: "Quota exhausted" },
      ],
    });
    expect(screen.getByText("Overall status: Warning")).toBeDefined();
  });

  it("renders a plugin failure with a link to open Plugins", () => {
    renderBody({
      pluginRows: [{ id: "flaky", label: "Flaky", level: "error", detail: "Crashed on load" }],
    });
    expect(screen.getByText("Crashed on load")).toBeDefined();
    expect(screen.getByRole("link", { name: "Open Plugins" })).toBeDefined();
  });

  it("exports a diagnostics report with no secrets via the Copy button", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);

    renderBody({
      accountRows: [{ id: "a1", label: "ChatGPT Plus", level: "healthy", detail: "Connected" }],
    });
    screen.getByRole("button", { name: /Copy diagnostics/i }).click();

    expect(writeText).toHaveBeenCalledTimes(1);
    const [reportText] = writeText.mock.calls[0] as [string];
    expect(reportText).toContain("Overall status");
    expect(reportText).not.toMatch(/sk-|bearer|token/i);
  });
});
