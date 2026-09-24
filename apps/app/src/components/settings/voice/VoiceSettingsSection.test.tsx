// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemVoiceCapabilitiesResponse } from "@bb/server-contract";
import { defaultVoiceSettings, type VoiceSettings } from "@bb/domain";
import type * as ApiModule from "@/lib/api";
import {
  prepareVoiceRuntime,
  readVoiceCapabilities,
  readVoiceProfiles,
} from "@/lib/api";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { VoiceSettingsSection } from "./VoiceSettingsSection";

vi.mock("@/components/ui/app-toast", () => ({
  appToast: {
    message: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    readVoiceCapabilities: vi.fn(),
    readVoiceProfiles: vi.fn(),
    repairVoiceRuntime: vi.fn(),
    downloadVoiceModel: vi.fn(),
    cancelVoiceModelDownload: vi.fn(),
    prepareVoiceRuntime: vi.fn(),
    deleteVoiceProfile: vi.fn(),
    updateVoiceProfile: vi.fn(),
    addVoiceProfileSample: vi.fn(),
  };
});

const EMPTY_CAPABILITIES: SystemVoiceCapabilitiesResponse = {
  voiceEnabled: true,
  runtimeState: "ready",
  version: "0.5.0",
  engines: [],
  speechModels: [],
};

function renderSection(voice: VoiceSettings, onVoiceChange = vi.fn()) {
  const { queryClient, wrapper } = createQueryClientTestHarness();
  render(
    <VoiceSettingsSection
      voice={voice}
      disabled={false}
      onVoiceChange={onVoiceChange}
    />,
    { wrapper },
  );
  return { queryClient, onVoiceChange };
}

beforeEach(() => {
  vi.mocked(readVoiceCapabilities).mockResolvedValue(EMPTY_CAPABILITIES);
  vi.mocked(readVoiceProfiles).mockResolvedValue({
    voiceEnabled: true,
    profiles: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VoiceSettingsSection persistence", () => {
  it("round-trips the reduce background noise toggle", async () => {
    const onVoiceChange = vi.fn();
    renderSection(defaultVoiceSettings, onVoiceChange);

    const toggle = await screen.findByRole("switch", {
      name: "Reduce background noise",
    });
    fireEvent.click(toggle);

    expect(onVoiceChange).toHaveBeenCalledWith({
      ...defaultVoiceSettings,
      input: { ...defaultVoiceSettings.input, reduceBackgroundNoise: false },
    });
  });

  it("round-trips the auto-speak behavior toggle", async () => {
    const onVoiceChange = vi.fn();
    renderSection(defaultVoiceSettings, onVoiceChange);

    const toggle = await screen.findByRole("switch", {
      name: "Automatically speak replies",
    });
    fireEvent.click(toggle);

    expect(onVoiceChange).toHaveBeenCalledWith({
      ...defaultVoiceSettings,
      behavior: {
        ...defaultVoiceSettings.behavior,
        autoSpeakReplies: true,
      },
    });
  });

  it("prepares the runtime when keep-warm is enabled", async () => {
    vi.mocked(prepareVoiceRuntime).mockResolvedValue({
      ok: true,
      runtimeState: "ready",
    });
    renderSection(defaultVoiceSettings);

    const toggle = await screen.findByRole("switch", {
      name: "Keep voice runtime warm",
    });
    fireEvent.click(toggle);

    expect(prepareVoiceRuntime).toHaveBeenCalledTimes(1);
  });

  it("round-trips the master voice enable switch", async () => {
    const onVoiceChange = vi.fn();
    renderSection(defaultVoiceSettings, onVoiceChange);

    const toggle = await screen.findByRole("switch", {
      name: "Enable Arc Voice",
    });
    fireEvent.click(toggle);

    expect(onVoiceChange).toHaveBeenCalledWith({
      ...defaultVoiceSettings,
      enabled: false,
    });
  });

  it("shows a disabled notice and disables repair when voice is off", async () => {
    renderSection({ ...defaultVoiceSettings, enabled: false });

    expect(
      await screen.findByText(
        /Voice is disabled\. Speak, dictation, previews, and the voice runtime/,
      ),
    ).toBeTruthy();
    const repair = screen.getByRole("button", { name: "Repair" });
    expect(repair).toHaveProperty("disabled", true);
  });

  it("round-trips the unload-models-after-use behavior toggle", async () => {
    const onVoiceChange = vi.fn();
    renderSection(defaultVoiceSettings, onVoiceChange);

    const toggle = await screen.findByRole("switch", {
      name: "Unload models after use",
    });
    fireEvent.click(toggle);

    expect(onVoiceChange).toHaveBeenCalledWith({
      ...defaultVoiceSettings,
      behavior: {
        ...defaultVoiceSettings.behavior,
        releaseModelsAfterUse: false,
      },
    });
  });

  it("renders an Agent Voices row per Arc agent defaulting to the default voice", async () => {
    renderSection(defaultVoiceSettings);

    for (const label of ["Codex", "Claude Code", "OMP"]) {
      expect(await screen.findByText(label)).toBeTruthy();
    }
    const triggers = screen.getAllByRole("button", { name: /Voice for / });
    expect(triggers).toHaveLength(3);
    for (const trigger of triggers) {
      expect(trigger.textContent).toContain("Default voice");
    }
  });

  it("assigns a custom voice to an agent voice", async () => {
    vi.mocked(readVoiceProfiles).mockResolvedValue({
      voiceEnabled: true,
      profiles: [
        {
          id: "p-1",
          name: "Morgan",
          description: null,
          language: "en",
          voiceType: "cloned",
          presetEngine: null,
          presetVoiceId: null,
          sampleCount: 1,
        },
      ],
    });
    const onVoiceChange = vi.fn();
    renderSection(defaultVoiceSettings, onVoiceChange);

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Voice for codex" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Morgan" }));

    expect(onVoiceChange).toHaveBeenCalledWith({
      ...defaultVoiceSettings,
      agentVoices: {
        ...defaultVoiceSettings.agentVoices,
        codex: {
          engine: "qwen",
          voiceKind: "profile",
          presetEngine: "qwen",
          presetVoiceId: null,
          profileId: "p-1",
        },
      },
    });
  });
});
