// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useOnboardingController: vi.fn(),
}));

vi.mock("@/hooks/useOnboarding", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useOnboarding")>(
    "@/hooks/useOnboarding",
  );
  return { ...actual, useOnboardingController: mocks.useOnboardingController };
});

import { OnboardingReplaySettingsSection } from "./OnboardingReplaySettingsSection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OnboardingReplaySettingsSection", () => {
  it("reopens onboarding when Replay setup is clicked", () => {
    const replay = vi.fn();
    mocks.useOnboardingController.mockReturnValue({
      open: false,
      dataReady: true,
      complete: vi.fn(),
      replay,
    });

    render(<OnboardingReplaySettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Replay setup" }));

    expect(replay).toHaveBeenCalledTimes(1);
  });
});
