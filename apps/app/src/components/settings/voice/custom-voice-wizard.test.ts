// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ApiModule from "@/lib/api";
import {
  addVoiceProfileSample,
  createVoiceProfile,
} from "@/lib/api";
import {
  canAdvanceFromStep,
  customVoiceWizardReducer,
  initialCustomVoiceWizardState,
  useCustomVoiceWizard,
} from "./custom-voice-wizard";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    createVoiceProfile: vi.fn(),
    addVoiceProfileSample: vi.fn(),
    transcribeVoiceInput: vi.fn(),
  };
});

function sampleFile(): File {
  return new File(["wav"], "sample.wav", { type: "audio/wav" });
}

function createdProfile() {
  return {
    id: "p1",
    name: "My Voice",
    description: null,
    language: "en",
    voiceType: "cloned",
    presetEngine: null,
    presetVoiceId: null,
    sampleCount: 0,
  };
}

function advanceToCreate(result: {
  current: ReturnType<typeof useCustomVoiceWizard>;
}) {
  act(() => result.current.dispatch({ type: "setConsented", value: true }));
  act(() => result.current.dispatch({ type: "setSample", file: sampleFile() }));
  act(() => result.current.dispatch({ type: "next" }));
  act(() => result.current.dispatch({ type: "next" }));
  act(() =>
    result.current.dispatch({ type: "setReference", value: "hello world" }),
  );
  act(() => result.current.dispatch({ type: "next" }));
  act(() => result.current.dispatch({ type: "setName", value: "My Voice" }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("custom voice wizard consent gate", () => {
  it("blocks advancement until consent is acknowledged", () => {
    expect(canAdvanceFromStep(initialCustomVoiceWizardState)).toBe(false);

    const blocked = customVoiceWizardReducer(initialCustomVoiceWizardState, {
      type: "next",
    });
    expect(blocked.step).toBe("consent");

    const consented = customVoiceWizardReducer(initialCustomVoiceWizardState, {
      type: "setConsented",
      value: true,
    });
    expect(canAdvanceFromStep(consented)).toBe(true);
  });

  it("requires a sample before leaving the sample step", () => {
    const consented = customVoiceWizardReducer(initialCustomVoiceWizardState, {
      type: "setConsented",
      value: true,
    });
    const onSample = customVoiceWizardReducer(consented, { type: "next" });
    expect(canAdvanceFromStep(onSample)).toBe(false);
  });
});

describe("useCustomVoiceWizard submit", () => {
  it("creates a profile before adding the sample", async () => {
    vi.mocked(createVoiceProfile).mockResolvedValue({
      profile: createdProfile(),
    });
    vi.mocked(addVoiceProfileSample).mockResolvedValue({ sampleId: "s1" });

    const { result } = renderHook(() => useCustomVoiceWizard());
    advanceToCreate(result);

    await act(async () => {
      await result.current.submit();
    });

    expect(createVoiceProfile).toHaveBeenCalledWith({
      name: "My Voice",
      description: null,
      language: "en",
      voiceType: "cloned",
      presetEngine: null,
      presetVoiceId: null,
    });
    expect(addVoiceProfileSample).toHaveBeenCalledWith(
      "p1",
      expect.any(File),
      "hello world",
    );

    const createOrder =
      vi.mocked(createVoiceProfile).mock.invocationCallOrder[0];
    const sampleOrder =
      vi.mocked(addVoiceProfileSample).mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(sampleOrder);
  });

  it("surfaces a sample failure and stays in the wizard", async () => {
    vi.mocked(createVoiceProfile).mockResolvedValue({
      profile: createdProfile(),
    });
    vi.mocked(addVoiceProfileSample).mockRejectedValue(
      new Error("sample upload failed"),
    );

    const { result } = renderHook(() => useCustomVoiceWizard());
    advanceToCreate(result);

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.state.error).toBe("sample upload failed");
    expect(result.current.state.submitting).toBe(false);
    expect(result.current.state.step).toBe("create");
    expect(result.current.state.createdProfile).not.toBeNull();
  });
});
