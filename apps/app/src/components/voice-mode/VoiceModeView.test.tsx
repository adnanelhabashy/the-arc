// @vitest-environment jsdom

import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { VoiceModeSessionController } from "./use-voice-mode-session";
import { useVoiceModeSession } from "./use-voice-mode-session";
import type { VoiceModeState } from "./voice-mode-state";
import { useVoiceEnabled } from "@/components/thread/timeline/voice-enabled";
import { VoiceModeView } from "./VoiceModeView";

vi.mock("./use-voice-mode-session", () => ({
  useVoiceModeSession: vi.fn(),
}));

vi.mock("@/components/thread/timeline/ThreadTimelineSurface", () => ({
  ThreadTimelineSurface: () => (
    <div data-testid="timeline-surface">timeline</div>
  ),
}));

vi.mock("@/components/thread/timeline/ProviderUsageSection", () => ({
  providerIdToAgentId: (providerId: string | undefined) =>
    providerId === "codex" ? "codex" : null,
}));

vi.mock("@/components/thread/timeline/voice-enabled", () => ({
  useVoiceEnabled: vi.fn(),
  VoiceEnabledContext: {
    Provider: ({ children }: { children: unknown }) => children,
  },
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({
    data: {
      id: "thr_1",
      providerId: "codex",
      runtime: { displayStatus: "idle" },
    },
  }),
  useThreadTimeline: () => ({
    data: { rows: [] },
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@bb/shared-ui/hooks/use-media-query", () => ({
  usePrefersReducedMotion: () => false,
}));

function controller(
  state: VoiceModeState,
): VoiceModeSessionController {
  return {
    state,
    micLevel: { level: 0 },
    ttsLevel: { level: 0 },
    begin: vi.fn(),
    endUtterance: vi.fn(),
    acknowledgeError: vi.fn(),
    exit: vi.fn(),
  };
}

function mockSession(state: VoiceModeState): VoiceModeSessionController {
  const value = controller(state);
  vi.mocked(useVoiceModeSession).mockReturnValue(value);
  return value;
}

function renderView(onExit = vi.fn()) {
  return render(
    <MemoryRouter>
      <VoiceModeView threadId="thr_1" projectId="proj_1" onExit={onExit} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useVoiceEnabled).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VoiceModeView", () => {
  it("begins the session on mount and shows the listening state", () => {
    mockSession({ kind: "listening" });
    renderView();
    expect(useVoiceModeSession).toHaveBeenCalled();
    expect(screen.getByText("Listening…")).toBeTruthy();
    expect(screen.getByTestId("timeline-surface")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("refuses entry with a settings hint when voice is disabled", () => {
    vi.mocked(useVoiceEnabled).mockReturnValue(false);
    mockSession({ kind: "idle" });
    renderView();
    expect(
      screen.getByText(/Voice is disabled/u),
    ).toBeTruthy();
    expect(screen.queryByTestId("timeline-surface")).toBeNull();
  });

  it("shows state text for each machine state", () => {
    const states: Array<[VoiceModeState, string]> = [
      [{ kind: "transcribing" }, "Transcribing…"],
      [{ kind: "thinking" }, "Thinking…"],
      [{ kind: "speaking", messageId: "msg_1" }, "Speaking…"],
      [{ kind: "interrupted" }, "Interrupted"],
    ];
    for (const [state, label] of states) {
      cleanup();
      mockSession(state);
      renderView();
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("shows the error detail and acknowledges on dismiss", () => {
    const session = controller({ kind: "error", message: "mic vanished" });
    vi.mocked(useVoiceModeSession).mockReturnValue(session);
    renderView();
    expect(screen.getByText("mic vanished")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(session.acknowledgeError).toHaveBeenCalledTimes(1);
  });

  it("hides the response detail control while an error is showing", () => {
    mockSession({ kind: "error", message: "mic vanished" });
    const { container } = renderView();
    const select = container.querySelector(
      'select[aria-label="Voice response detail"]',
    );
    expect(select).not.toBeNull();
    expect(select?.hasAttribute("hidden")).toBe(true);
  });

  it("exit button tears down and calls onExit", () => {
    const onExit = vi.fn();
    const session = controller({ kind: "listening" });
    vi.mocked(useVoiceModeSession).mockReturnValue(session);
    renderView(onExit);
    fireEvent.click(screen.getByRole("button", { name: "Exit voice mode" }));
    expect(session.exit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("Escape exits", () => {
    const onExit = vi.fn();
    const session = controller({ kind: "listening" });
    vi.mocked(useVoiceModeSession).mockReturnValue(session);
    renderView(onExit);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(session.exit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("switches the response detail control", () => {
    mockSession({ kind: "idle" });
    renderView();
    const select = screen.getByRole("combobox", {
      name: "Voice response detail",
    });
    fireEvent.change(select, { target: { value: "brief" } });
    expect((select as HTMLSelectElement).value).toBe("brief");
  });
});
