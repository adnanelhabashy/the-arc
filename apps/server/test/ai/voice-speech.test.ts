import { describe, expect, it, vi } from "vitest";
import { setAppSettings } from "@bb/db";
import { defaultAppSettings, type VoiceAgentSelection } from "@bb/domain";
import {
  listVoiceSpeechProfiles,
  prepareVoiceSpeechRuntime,
  readVoiceSpeechCapabilities,
  readVoiceSpeechStatus,
  releaseVoiceSpeechRuntime,
  speakVoiceText,
} from "../../src/services/ai/voice-speech.js";
import { registerFakeAiService } from "../helpers/ai-services.js";
import { seedHostSession, seedPrimaryHost } from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("speakVoiceText", () => {
  it("rejects empty speakable text with a 400", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      registerFakeAiService(harness.deps.aiServices, {
        speakVoice: () => ({
          ok: true,
          audioBase64: "AAAA",
          contentType: "audio/wav",
          durationMs: null,
        }),
      });

      await expect(
        speakVoiceText(harness.deps, { text: "```ts\nconst a = 1;\n```" }),
      ).rejects.toMatchObject({
        status: 400,
        body: { code: "invalid_request" },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("maps a plugin timeout to a final 504 without retrying", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const fake = registerFakeAiService(harness.deps.aiServices, {
        speakVoice: () => ({ ok: false, code: "timeout", message: "slow" }),
      });

      await expect(
        speakVoiceText(harness.deps, { text: "Hello" }),
      ).rejects.toMatchObject({
        status: 504,
        body: { code: "voice_speak_timeout", retryable: true },
      });
      expect(fake.speakCalls).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("maps service_unavailable to a 503", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      registerFakeAiService(harness.deps.aiServices, {
        speakVoice: () => ({
          ok: false,
          code: "service_unavailable",
          message: "down",
        }),
      });

      await expect(
        speakVoiceText(harness.deps, { text: "Hello" }),
      ).rejects.toMatchObject({
        status: 503,
        body: { code: "voice_speak_unavailable", retryable: true },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("surfaces a caller abort as cancelled before calling the service", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const fake = registerFakeAiService(harness.deps.aiServices, {
        speakVoice: () => ({
          ok: true,
          audioBase64: "AAAA",
          contentType: "audio/wav",
          durationMs: null,
        }),
      });
      const controller = new AbortController();
      controller.abort();

      await expect(
        speakVoiceText(harness.deps, {
          text: "Hello",
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        status: 408,
        body: { code: "voice_speak_cancelled" },
      });
      expect(fake.speakCalls).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns the audio bytes on success", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      registerFakeAiService(harness.deps.aiServices, {
        speakVoice: () => ({
          ok: true,
          audioBase64: "AAAA",
          contentType: "audio/wav",
          durationMs: 1500,
        }),
      });

      const result = await speakVoiceText(harness.deps, { text: "Hello there" });
      expect(result.contentType).toBe("audio/wav");
      expect([...result.audio]).toEqual([0, 0, 0]);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("readVoiceSpeechStatus", () => {
  it("reports unavailable when no voice service is configured", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "openai/gpt-transcribe",
      openAiApiKey: "",
    });
    try {
      expect(await readVoiceSpeechStatus(harness.deps)).toEqual({
        transcriptionEnabled: false,
        voiceEnabled: true,
        speech: {
          runtimeState: "unavailable",
          version: null,
          speechModelLoaded: false,
          voiceModel: null,
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("maps a ready plugin status through", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      registerFakeAiService(harness.deps.aiServices, {
        readVoiceStatus: () => ({
          ok: true,
          runtimeState: "ready",
          version: "0.5.0",
          speechModelLoaded: true,
          voiceModel: {
            engine: "kokoro",
            size: "",
            downloaded: true,
            loaded: true,
            downloading: false,
            downloadPercent: null,
          },
        }),
      });

      const status = await readVoiceSpeechStatus(harness.deps);
      expect(status.transcriptionEnabled).toBe(true);
      expect(status.speech.runtimeState).toBe("ready");
      expect(status.speech.speechModelLoaded).toBe(true);
      expect(status.speech.voiceModel).toMatchObject({
        engine: "kokoro",
        size: "",
      });
    } finally {
      await harness.cleanup();
    }
  });
});

describe("speakVoiceText settings selection", () => {
  it("speaks with the persisted preset voice selection by default", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const fake = registerFakeAiService(harness.deps.aiServices, {
        speakVoice: () => ({
          ok: true,
          audioBase64: "AAAA",
          contentType: "audio/wav",
          durationMs: null,
        }),
      });

      await speakVoiceText(harness.deps, { text: "Hello" });

      expect(fake.speakCalls).toHaveLength(1);
      expect(fake.speakCalls[0]?.input.engine).toBe("kokoro");
      expect(fake.speakCalls[0]?.input.profile).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("speaks through the persisted cloned profile selection", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      setAppSettings(harness.deps.db, {
        ...defaultAppSettings,
        voice: {
          ...defaultAppSettings.voice,
          tts: {
            engine: "qwen_custom_voice",
            voiceKind: "profile",
            presetEngine: "kokoro",
            presetVoiceId: "af_heart",
            profileId: "9f1c2d",
            playbackSpeed: 1,
          },
        },
      });
      const fake = registerFakeAiService(harness.deps.aiServices, {
        speakVoice: () => ({
          ok: true,
          audioBase64: "AAAA",
          contentType: "audio/wav",
          durationMs: null,
        }),
      });

      await speakVoiceText(harness.deps, { text: "Hello" });

      expect(fake.speakCalls[0]?.input.engine).toBe("qwen_custom_voice");
      expect(fake.speakCalls[0]?.input.profile).toBe("9f1c2d");
    } finally {
      await harness.cleanup();
    }
  });

  it("lets an explicit engine/profile override the persisted selection", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const fake = registerFakeAiService(harness.deps.aiServices, {
        speakVoice: () => ({
          ok: true,
          audioBase64: "AAAA",
          contentType: "audio/wav",
          durationMs: null,
        }),
      });

      await speakVoiceText(harness.deps, {
        text: "Hello",
        engine: "kokoro",
        profile: "Arc Voice · Heart",
      });

      expect(fake.speakCalls[0]?.input.engine).toBe("kokoro");
      expect(fake.speakCalls[0]?.input.profile).toBe("Arc Voice · Heart");
    } finally {
      await harness.cleanup();
    }
  });

  it("refuses qwen without a cloned profile on both selection paths", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      setAppSettings(harness.deps.db, {
        ...defaultAppSettings,
        voice: {
          ...defaultAppSettings.voice,
          tts: { ...defaultAppSettings.voice.tts, engine: "qwen" },
        },
      });
      const fake = registerFakeAiService(harness.deps.aiServices, {
        speakVoice: () => ({
          ok: true,
          audioBase64: "AAAA",
          contentType: "audio/wav",
          durationMs: null,
        }),
      });

      await expect(
        speakVoiceText(harness.deps, { text: "Hello" }),
      ).rejects.toMatchObject({
        status: 400,
        body: { code: "invalid_request" },
      });
      await expect(
        speakVoiceText(harness.deps, { text: "Hello", engine: "qwen" }),
      ).rejects.toMatchObject({
        status: 400,
        body: { code: "invalid_request" },
      });
      expect(fake.speakCalls).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("V5 per-agent voices", () => {
  const KOKORO_CAPS = {
    ok: true as const,
    runtimeState: "ready" as const,
    version: "0.5.0",
    engines: [
      {
        engine: "kokoro",
        requiresClonedProfile: false,
        presets: [
          { voiceId: "af_heart", name: "Heart", gender: "female", language: "en" },
          { voiceId: "am_adam", name: "Adam", gender: "male", language: "en" },
        ],
        models: [],
      },
    ],
    speechModels: [],
  };
  const speakOk = () => ({
    ok: true as const,
    audioBase64: "AAAA",
    contentType: "audio/wav",
    durationMs: null,
  });

  async function seedAgentVoiceHarness(
    agentVoices: Partial<
      Record<"codex" | "claude-code" | "omp", VoiceAgentSelection>
    >,
    fakeArgs: Parameters<typeof registerFakeAiService>[1] = {},
  ) {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    const { host } = seedHostSession(harness.deps);
    seedPrimaryHost(harness.deps, host.id);
    setAppSettings(harness.deps.db, {
      ...defaultAppSettings,
      voice: {
        ...defaultAppSettings.voice,
        agentVoices: {
          codex: null,
          "claude-code": null,
          omp: null,
          ...agentVoices,
        },
      },
    });
    const fake = registerFakeAiService(harness.deps.aiServices, {
      readVoiceCapabilities: () => KOKORO_CAPS,
      speakVoice: speakOk,
      ...fakeArgs,
    });
    return { harness, fake };
  }

  it.each(["codex", "claude-code", "omp"] as const)(
    "speaks with the configured preset voice for %s",
    async (agentId) => {
      const { harness, fake } = await seedAgentVoiceHarness({
        [agentId]: {
          engine: "kokoro",
          voiceKind: "preset",
          presetEngine: "kokoro",
          presetVoiceId: "am_adam",
          profileId: null,
        },
      });
      try {
        await speakVoiceText(harness.deps, { text: "Hello", agentId });
        expect(fake.speakCalls).toHaveLength(1);
        expect(fake.speakCalls[0]?.input.engine).toBe("kokoro");
        expect(fake.speakCalls[0]?.input.voiceId).toBe("am_adam");
      } finally {
        await harness.cleanup();
      }
    },
  );

  it("speaks with the configured custom profile voice", async () => {
    const { harness, fake } = await seedAgentVoiceHarness(
      {
        "claude-code": {
          engine: "qwen",
          voiceKind: "profile",
          presetEngine: "qwen",
          presetVoiceId: null,
          profileId: "p-1",
        },
      },
      {
        listVoiceProfiles: () => ({
          ok: true as const,
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
        }),
      },
    );
    try {
      await speakVoiceText(harness.deps, { text: "Hello", agentId: "claude-code" });
      expect(fake.speakCalls).toHaveLength(1);
      expect(fake.speakCalls[0]?.input.engine).toBe("qwen");
      expect(fake.speakCalls[0]?.input.profile).toBe("p-1");
    } finally {
      await harness.cleanup();
    }
  });

  it("falls back to the global default when the assigned profile was deleted", async () => {
    const { harness, fake } = await seedAgentVoiceHarness(
      {
        codex: {
          engine: "qwen",
          voiceKind: "profile",
          presetEngine: "qwen",
          presetVoiceId: null,
          profileId: "gone",
        },
      },
      { listVoiceProfiles: () => ({ ok: true as const, profiles: [] }) },
    );
    try {
      await speakVoiceText(harness.deps, { text: "Hello", agentId: "codex" });
      expect(fake.speakCalls).toHaveLength(1);
      expect(fake.speakCalls[0]?.input.engine).toBe("kokoro");
      expect(fake.speakCalls[0]?.input.voiceId).toBe("af_heart");
    } finally {
      await harness.cleanup();
    }
  });

  it("falls back to the global default when the assigned preset no longer exists", async () => {
    const { harness, fake } = await seedAgentVoiceHarness({
      omp: {
        engine: "kokoro",
        voiceKind: "preset",
        presetEngine: "kokoro",
        presetVoiceId: "af_missing",
        profileId: null,
      },
    });
    try {
      await speakVoiceText(harness.deps, { text: "Hello", agentId: "omp" });
      expect(fake.speakCalls).toHaveLength(1);
      expect(fake.speakCalls[0]?.input.voiceId).toBe("af_heart");
    } finally {
      await harness.cleanup();
    }
  });

  it("lets an explicit engine/profile override beat the agent voice", async () => {
    const { harness, fake } = await seedAgentVoiceHarness({
      codex: {
        engine: "kokoro",
        voiceKind: "preset",
        presetEngine: "kokoro",
        presetVoiceId: "am_adam",
        profileId: null,
      },
    });
    try {
      await speakVoiceText(harness.deps, {
        text: "Hello",
        agentId: "codex",
        engine: "kokoro",
        voiceId: "af_heart",
      });
      expect(fake.speakCalls[0]?.input.voiceId).toBe("af_heart");
    } finally {
      await harness.cleanup();
    }
  });

  it("uses the global default when no agentId is passed", async () => {
    const { harness, fake } = await seedAgentVoiceHarness({
      codex: {
        engine: "kokoro",
        voiceKind: "preset",
        presetEngine: "kokoro",
        presetVoiceId: "am_adam",
        profileId: null,
      },
    });
    try {
      await speakVoiceText(harness.deps, { text: "Hello" });
      expect(fake.speakCalls[0]?.input.voiceId).toBe("af_heart");
    } finally {
      await harness.cleanup();
    }
  });
});

describe("V5 master voice switch", () => {
  const speakOk = () => ({
    ok: true as const,
    audioBase64: "AAAA",
    contentType: "audio/wav",
    durationMs: null,
  });

  async function seedDisabledVoiceHarness() {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    const { host } = seedHostSession(harness.deps);
    seedPrimaryHost(harness.deps, host.id);
    setAppSettings(harness.deps.db, {
      ...defaultAppSettings,
      voice: { ...defaultAppSettings.voice, enabled: false },
    });
    // No handlers registered: any host RPC would throw, proving none happened.
    const fake = registerFakeAiService(harness.deps.aiServices, {});
    return { harness, fake };
  }

  it("refuses speak with voice_disabled and performs no host RPC", async () => {
    const { harness, fake } = await seedDisabledVoiceHarness();
    try {
      await expect(
        speakVoiceText(harness.deps, { text: "Hello" }),
      ).rejects.toMatchObject({
        status: 403,
        body: { code: "voice_disabled", retryable: false },
      });
      expect(fake.speakCalls).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns empty capabilities with voiceEnabled false and no host RPC", async () => {
    const { harness } = await seedDisabledVoiceHarness();
    try {
      const capabilities = await readVoiceSpeechCapabilities(harness.deps);
      expect(capabilities).toEqual({
        voiceEnabled: false,
        runtimeState: "stopped",
        version: null,
        engines: [],
        speechModels: [],
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns empty profiles with voiceEnabled false and no host RPC", async () => {
    const { harness } = await seedDisabledVoiceHarness();
    try {
      const profiles = await listVoiceSpeechProfiles(harness.deps);
      expect(profiles).toEqual({ profiles: [], voiceEnabled: false });
    } finally {
      await harness.cleanup();
    }
  });

  it("refuses keep-warm prepare with voice_disabled", async () => {
    const { harness } = await seedDisabledVoiceHarness();
    try {
      await expect(
        prepareVoiceSpeechRuntime(harness.deps),
      ).rejects.toMatchObject({
        status: 403,
        body: { code: "voice_disabled" },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("release stops the runtime through the host", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const fake = registerFakeAiService(harness.deps.aiServices, {
        releaseVoiceRuntime: () => ({
          ok: true as const,
          runtimeState: "stopped" as const,
        }),
        speakVoice: speakOk,
      });
      const result = await releaseVoiceSpeechRuntime(harness.deps);
      expect(result).toEqual({ runtimeState: "stopped" });
      expect(fake.releaseCalls).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("unloads models after a speak when releaseModelsAfterUse is on", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "codex/gpt-transcribe",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const fake = registerFakeAiService(harness.deps.aiServices, {
        readVoiceCapabilities: () => ({
          ok: true as const,
          runtimeState: "ready" as const,
          version: "0.5.0",
          engines: [
            {
              engine: "kokoro",
              requiresClonedProfile: false,
              presets: [
                {
                  voiceId: "af_heart",
                  name: "Heart",
                  gender: "female",
                  language: "en",
                },
              ],
              models: [],
            },
          ],
          speechModels: [],
        }),
        speakVoice: speakOk,
        unloadVoiceModels: () => ({ ok: true as const }),
      });
      await speakVoiceText(harness.deps, { text: "Hello" });
      expect(fake.speakCalls).toHaveLength(1);
      await vi.waitFor(() => expect(fake.unloadCalls).toHaveLength(1));
    } finally {
      await harness.cleanup();
    }
  });
});
