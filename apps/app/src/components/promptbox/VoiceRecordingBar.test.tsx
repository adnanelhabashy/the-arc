// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceRecordingBar } from "./VoiceRecordingBar";

vi.mock("./WaveformVisualizer.js", () => ({
  WaveformVisualizer: () => <div data-testid="waveform" />,
}));

afterEach(cleanup);

describe("VoiceRecordingBar", () => {
  it("renders the processing phase as visible text", () => {
    const { rerender } = render(
      <VoiceRecordingBar
        state="preparing"
        stream={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const preparing = screen.getAllByText("Preparing speech model…");
    expect(preparing.some((node) => !node.className.includes("sr-only"))).toBe(
      true,
    );

    rerender(
      <VoiceRecordingBar
        state="transcribing"
        stream={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const transcribing = screen.getAllByText("Transcribing locally…");
    expect(
      transcribing.some((node) => !node.className.includes("sr-only")),
    ).toBe(true);
  });

  it("disables confirm while transcribing", () => {
    const onConfirm = vi.fn();
    render(
      <VoiceRecordingBar
        state="transcribing"
        stream={null}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const confirm = screen.getByRole("button", {
      name: "Transcribing locally…",
    });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    expect(
      screen.getByRole("button", { name: "Cancel transcription" }),
    ).toBeTruthy();
  });

  it("shows the preparing label and keeps the transcription cancel label", () => {
    const onConfirm = vi.fn();
    render(
      <VoiceRecordingBar
        state="preparing"
        stream={null}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const confirm = screen.getByRole("button", {
      name: "Preparing speech model…",
    });
    expect(confirm).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Cancel transcription" }),
    ).toBeTruthy();
  });
});
