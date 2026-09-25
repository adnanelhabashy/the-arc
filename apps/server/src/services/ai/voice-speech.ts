import { Buffer } from "node:buffer";
import { getAppSettings } from "@bb/db";
import type {
  SystemVoiceCapabilitiesResponse,
  SystemVoiceProfile,
  SystemVoiceProfileCreateRequest,
  SystemVoiceProfileUpdateRequest,
  SystemVoiceProfilesResponse,
  SystemVoiceStatusResponse,
} from "@bb/server-contract";
import type {
  ExperimentalVoiceEngineCapabilities,
  ExperimentalVoiceProfile,
} from "@get-bb/plugin-sdk/ai-services";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requireConnectedPrimaryHostId } from "../hosts/primary-host.js";
import {
  isPrimaryHostConnected,
  resolveVoiceService,
  resolveVoiceTranscriptionEnabled,
} from "./voice-transcription.js";
import { deriveSpeakableText } from "./voice-speakable-text.js";

export type VoiceSpeakAgentId = "codex" | "claude-code" | "omp";

export function isVoiceEnabled(deps: LoggedWorkSessionDeps): boolean {
  return getAppSettings(deps.db).voice.enabled;
}

function assertVoiceEnabled(deps: LoggedWorkSessionDeps): void {
  if (!isVoiceEnabled(deps)) {
    throw new ApiError(
      403,
      "voice_disabled",
      "Voice is disabled. Enable it in Settings → Voice.",
      false,
    );
  }
}

export const VOICE_SPEAK_OPERATION_BUDGET_MS = 180_000;
export const VOICE_SPEAK_HOST_DEADLINE_MARGIN_MS = 15_000;
export const VOICE_SPEAK_HOST_DEADLINE_MS =
  VOICE_SPEAK_OPERATION_BUDGET_MS + VOICE_SPEAK_HOST_DEADLINE_MARGIN_MS;
export const VOICE_STATUS_HOST_DEADLINE_MS = 10_000;

function buildSpeakCancelledError(): ApiError {
  return new ApiError(408, "voice_speak_cancelled", "Voice speech was cancelled", false);
}

function buildSpeakTimeoutError(): ApiError {
  return new ApiError(504, "voice_speak_timeout", "Voice speech timed out", true);
}

function buildSpeakUnavailableError(): ApiError {
  return new ApiError(
    503,
    "voice_speak_unavailable",
    "Voice speech is temporarily unavailable. Please try again in a moment.",
    true,
  );
}

function buildSpeakFailedError(): ApiError {
  return new ApiError(502, "voice_speak_failed", "Voice speech failed", false);
}

function unavailableStatus(
  transcriptionEnabled: boolean,
  voiceEnabled: boolean,
): SystemVoiceStatusResponse {
  return {
    transcriptionEnabled,
    voiceEnabled,
    speech: {
      runtimeState: "unavailable",
      version: null,
      speechModelLoaded: false,
      voiceModel: null,
    },
  };
}

export async function readVoiceSpeechStatus(
  deps: LoggedWorkSessionDeps,
): Promise<SystemVoiceStatusResponse> {
  const transcriptionEnabled = resolveVoiceTranscriptionEnabled(deps);
  if (!isVoiceEnabled(deps)) {
    // Serving the disabled state must never touch the runtime.
    return {
      transcriptionEnabled,
      voiceEnabled: false,
      speech: {
        runtimeState: "stopped",
        version: null,
        speechModelLoaded: false,
        voiceModel: null,
      },
    };
  }
  const service = resolveVoiceService(deps);
  if (service === null || !isPrimaryHostConnected(deps)) {
    return unavailableStatus(transcriptionEnabled, true);
  }

  try {
    const hostId = requireConnectedPrimaryHostId(deps);
    const result = await service.readVoiceStatus(
      { serviceId: service.id },
      { hostId, timeoutMs: VOICE_STATUS_HOST_DEADLINE_MS },
    );
    if (!result.ok) {
      return unavailableStatus(transcriptionEnabled, true);
    }
    return {
      transcriptionEnabled,
      voiceEnabled: true,
      speech: {
        runtimeState: result.runtimeState,
        version: result.version,
        speechModelLoaded: result.speechModelLoaded,
        voiceModel: result.voiceModel,
      },
    };
  } catch {
    return unavailableStatus(transcriptionEnabled, true);
  }
}

interface SpeakVoiceSelection {
  engine: string | null;
  profile: string | null;
  voiceId: string | null;
  language: string | null;
}

async function validateAgentVoiceSelection(
  deps: LoggedWorkSessionDeps,
  selection: {
    engine: string;
    voiceKind: "preset" | "profile";
    presetEngine: string;
    presetVoiceId: string | null;
    profileId: string | null;
  },
): Promise<SpeakVoiceSelection | null> {
  const service = resolveVoiceService(deps);
  if (service === null || !isPrimaryHostConnected(deps)) {
    return null;
  }
  const hostId = requireConnectedPrimaryHostId(deps);
  const options = { hostId, timeoutMs: VOICE_STATUS_HOST_DEADLINE_MS };
  if (selection.voiceKind === "profile") {
    if (selection.profileId === null) {
      return null;
    }
    const result = await service.listVoiceProfiles(
      { serviceId: service.id },
      options,
    );
    if (!result.ok) {
      return null;
    }
    if (!result.profiles.some((profile) => profile.id === selection.profileId)) {
      return null;
    }
    return {
      engine: selection.engine,
      profile: selection.profileId,
      voiceId: null,
      language: null,
    };
  }
  const capabilities = await service.readVoiceCapabilities(
    { serviceId: service.id },
    options,
  );
  if (!capabilities.ok) {
    return null;
  }
  if (selection.presetVoiceId === null) {
    return null;
  }
  const engine = validatePresetAgainstCapabilities(
    capabilities.engines,
    selection.presetEngine,
    selection.presetVoiceId,
  );
  if (engine === null) {
    return null;
  }
  return {
    engine,
    profile: null,
    voiceId: selection.presetVoiceId,
    language: null,
  };
}

function validatePresetAgainstCapabilities(
  engines: readonly ExperimentalVoiceEngineCapabilities[],
  presetEngine: string,
  presetVoiceId: string,
): string | null {
  const engine = engines.find((entry) => entry.engine === presetEngine);
  if (engine === undefined || engine.presets === null) {
    return null;
  }
  if (!engine.presets.some((preset) => preset.voiceId === presetVoiceId)) {
    return null;
  }
  return presetEngine;
}

async function resolveSpeakVoiceSelection(
  deps: LoggedWorkSessionDeps,
  args: {
    engine?: string;
    profile?: string;
    voiceId?: string;
    language?: string;
    agentId?: VoiceSpeakAgentId;
  },
): Promise<SpeakVoiceSelection> {
  if (
    args.engine !== undefined ||
    args.profile !== undefined ||
    args.voiceId !== undefined ||
    args.language !== undefined
  ) {
    return {
      engine: args.engine ?? null,
      profile: args.profile ?? null,
      voiceId: args.voiceId ?? null,
      language: args.language ?? null,
    };
  }
  const voice = getAppSettings(deps.db).voice;
  // Thread voice override slot: reserved for a future phase; nothing to resolve in V5.
  if (args.agentId !== undefined) {
    const agentSelection = voice.agentVoices[args.agentId] ?? null;
    if (agentSelection !== null) {
      const validated = await validateAgentVoiceSelection(deps, agentSelection);
      if (validated !== null) {
        return validated;
      }
    }
  }
  const tts = voice.tts;
  if (tts.voiceKind === "profile" && tts.profileId !== null) {
    return {
      engine: tts.engine,
      profile: tts.profileId,
      voiceId: null,
      language: null,
    };
  }
  if (tts.engine === "qwen") {
    throw new ApiError(
      400,
      "invalid_request",
      "Qwen speaks only through a cloned voice. Create a custom voice in Voice settings first.",
      false,
    );
  }
  return {
    engine: tts.engine,
    profile: null,
    voiceId: tts.presetVoiceId,
    language: null,
  };
}

export async function speakVoiceText(
  deps: LoggedWorkSessionDeps,
  args: {
    text: string;
    signal?: AbortSignal;
    engine?: string;
    profile?: string;
    voiceId?: string;
    language?: string;
    agentId?: VoiceSpeakAgentId;
    detail?: "brief" | "balanced" | "full";
  },
): Promise<{ audio: Uint8Array; contentType: string }> {
  assertVoiceEnabled(deps);
  const spoken = deriveSpeakableText(args.text, args.detail ?? "balanced");
  if (spoken.text.length === 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "There is nothing in this message to speak.",
    );
  }

  const service = resolveVoiceService(deps);
  if (service === null) {
    throw new ApiError(
      501,
      "not_configured",
      "No loaded plugin registers an AI service for voice speech",
    );
  }

  const signal = args.signal;
  const isCancelled = (): boolean => signal?.aborted === true;
  if (isCancelled()) {
    throw buildSpeakCancelledError();
  }

  const hostId = requireConnectedPrimaryHostId(deps);
  voiceOperationStarted();
  let selection: SpeakVoiceSelection;
  try {
    selection = await resolveSpeakVoiceSelection(deps, args);
  } catch (error) {
    voiceOperationFinished(deps);
    throw error;
  }
  if (
    (selection.engine === "qwen" && selection.profile === null) ||
    (selection.engine === "qwen_custom_voice" &&
      selection.profile === null &&
      selection.voiceId === null)
  ) {
    voiceOperationFinished(deps);
    throw new ApiError(
      400,
      "invalid_request",
      "Qwen speaks only through a cloned voice. Create a custom voice in Voice settings first.",
      false,
    );
  }

  let result;
  try {
    result = await service.speakVoice(
      {
        serviceId: service.id,
        text: spoken.text,
        language: selection.language,
        profile: selection.profile,
        engine: selection.engine,
        voiceId: selection.voiceId,
        timeoutMs: VOICE_SPEAK_OPERATION_BUDGET_MS,
      },
      {
        hostId,
        timeoutMs: VOICE_SPEAK_HOST_DEADLINE_MS,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      },
    );
  } catch {
    if (isCancelled()) {
      throw buildSpeakCancelledError();
    }
    throw buildSpeakFailedError();
  } finally {
    voiceOperationFinished(deps);
  }

  if (!result.ok) {
    if (isCancelled()) {
      throw buildSpeakCancelledError();
    }
    if (result.code === "timeout") {
      throw buildSpeakTimeoutError();
    }
    if (
      result.code === "service_unavailable" ||
      result.code === "rate_limited"
    ) {
      throw buildSpeakUnavailableError();
    }
    throw buildSpeakFailedError();
  }

  const audio = Buffer.from(result.audioBase64, "base64");
  return { audio: new Uint8Array(audio), contentType: result.contentType };
}

const VOICE_CONTROL_HOST_DEADLINE_MS = 120_000;
const VOICE_RELEASE_DRAIN_INTERVAL_MS = 250;
const VOICE_RELEASE_DRAIN_MAX_MS = 5_000;

let inFlightVoiceOperations = 0;

function voiceOperationStarted(): void {
  inFlightVoiceOperations += 1;
}

function voiceOperationFinished(deps: LoggedWorkSessionDeps): void {
  inFlightVoiceOperations = Math.max(0, inFlightVoiceOperations - 1);
  if (
    inFlightVoiceOperations === 0 &&
    getAppSettings(deps.db).voice.behavior.releaseModelsAfterUse === true &&
    isVoiceEnabled(deps)
  ) {
    void unloadVoiceSpeechModels(deps).catch(() => undefined);
  }
}

async function unloadVoiceSpeechModels(deps: LoggedWorkSessionDeps): Promise<void> {
  const service = resolveVoiceService(deps);
  if (service === null || !isPrimaryHostConnected(deps)) {
    return;
  }
  const hostId = requireConnectedPrimaryHostId(deps);
  await service.unloadVoiceModels(
    { serviceId: service.id },
    { hostId, timeoutMs: VOICE_STATUS_HOST_DEADLINE_MS },
  );
}

export async function releaseVoiceSpeechRuntime(
  deps: LoggedWorkSessionDeps,
  options?: { signal?: AbortSignal },
): Promise<{ runtimeState: "stopped" | "not-running" }> {
  const service = resolveVoiceService(deps);
  if (service === null || !isPrimaryHostConnected(deps)) {
    return { runtimeState: "not-running" };
  }
  const drainDeadline = Date.now() + VOICE_RELEASE_DRAIN_MAX_MS;
  while (
    inFlightVoiceOperations > 0 &&
    Date.now() < drainDeadline &&
    options?.signal?.aborted !== true
  ) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, VOICE_RELEASE_DRAIN_INTERVAL_MS);
    });
  }
  const hostId = requireConnectedPrimaryHostId(deps);
  const result = await service.releaseVoiceRuntime(
    { serviceId: service.id },
    { hostId, timeoutMs: VOICE_CONTROL_HOST_DEADLINE_MS },
  );
  if (!result.ok) {
    if (result.code === "request_failed") {
      // Older daemons do not implement ai.voice.release; there is nothing to stop
      // from the server's side, so treat it as already released.
      return { runtimeState: "not-running" };
    }
    mapVoiceControlFailure(result);
  }
  return { runtimeState: result.runtimeState };
}

export async function releaseVoiceSpeechRuntimeAfterSettingsChange(
  deps: LoggedWorkSessionDeps,
  previousEnabled: boolean,
  nextEnabled: boolean,
): Promise<void> {
  try {
    if (previousEnabled && !nextEnabled) {
      await releaseVoiceSpeechRuntime(deps);
      return;
    }
    if (
      !previousEnabled &&
      nextEnabled &&
      getAppSettings(deps.db).voice.behavior.keepWarm
    ) {
      await prepareVoiceSpeechRuntime(deps);
    }
  } catch {
    // Release/re-warm after a settings change is best-effort; the settings write
    // itself already succeeded and voice stays correct on next use.
  }
}

function buildVoiceControlUnavailableError(message: string): ApiError {
  return new ApiError(503, "voice_unavailable", message, true);
}

function requireVoiceService(
  deps: LoggedWorkSessionDeps,
): ReturnType<typeof resolveVoiceService> & object {
  const service = resolveVoiceService(deps);
  if (service === null || !isPrimaryHostConnected(deps)) {
    throw buildVoiceControlUnavailableError(
      "Voice is unavailable: the Arc Voice service is not reachable on this machine",
    );
  }
  return service;
}

function mapVoiceControlFailure(
  result: { ok: false; code: string; message: string },
): never {
  throw buildVoiceControlUnavailableError(result.message);
}

export async function readVoiceSpeechCapabilities(
  deps: LoggedWorkSessionDeps,
): Promise<SystemVoiceCapabilitiesResponse> {
  if (!isVoiceEnabled(deps)) {
    // No host RPC: serving the disabled state must never start the runtime.
    return {
      voiceEnabled: false,
      runtimeState: "stopped",
      version: null,
      engines: [],
      speechModels: [],
    };
  }
  const service = requireVoiceService(deps);
  const hostId = requireConnectedPrimaryHostId(deps);
  const result = await service.readVoiceCapabilities(
    { serviceId: service.id },
    { hostId, timeoutMs: VOICE_CONTROL_HOST_DEADLINE_MS },
  );
  if (!result.ok) {
    mapVoiceControlFailure(result);
  }
  return {
    voiceEnabled: true,
    runtimeState:
      result.runtimeState === "ready" ||
      result.runtimeState === "starting" ||
      result.runtimeState === "stopped"
        ? result.runtimeState
        : "unavailable",
    version: result.version,
    engines: result.engines,
    speechModels: result.speechModels,
  };
}

function toSystemVoiceProfile(
  profile: ExperimentalVoiceProfile,
): SystemVoiceProfile {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    language: profile.language,
    voiceType: profile.voiceType,
    presetEngine: profile.presetEngine,
    presetVoiceId: profile.presetVoiceId,
    sampleCount: profile.sampleCount,
  };
}

export async function listVoiceSpeechProfiles(
  deps: LoggedWorkSessionDeps,
): Promise<SystemVoiceProfilesResponse> {
  if (!isVoiceEnabled(deps)) {
    return { profiles: [], voiceEnabled: false };
  }
  const service = requireVoiceService(deps);
  const hostId = requireConnectedPrimaryHostId(deps);
  const result = await service.listVoiceProfiles(
    { serviceId: service.id },
    { hostId, timeoutMs: VOICE_CONTROL_HOST_DEADLINE_MS },
  );
  if (!result.ok) {
    mapVoiceControlFailure(result);
  }
  return { profiles: result.profiles.map(toSystemVoiceProfile), voiceEnabled: true };
}

export async function createVoiceSpeechProfile(
  deps: LoggedWorkSessionDeps,
  input: SystemVoiceProfileCreateRequest,
): Promise<{ profile: SystemVoiceProfile }> {
  assertVoiceEnabled(deps);
  const service = requireVoiceService(deps);
  const hostId = requireConnectedPrimaryHostId(deps);
  const result = await service.createVoiceProfile(
    { serviceId: service.id, ...input },
    { hostId, timeoutMs: VOICE_CONTROL_HOST_DEADLINE_MS },
  );
  if (!result.ok) {
    mapVoiceControlFailure(result);
  }
  return { profile: toSystemVoiceProfile(result.profile) };
}

export async function updateVoiceSpeechProfile(
  deps: LoggedWorkSessionDeps,
  profileId: string,
  input: SystemVoiceProfileUpdateRequest,
): Promise<{ profile: SystemVoiceProfile }> {
  assertVoiceEnabled(deps);
  const service = requireVoiceService(deps);
  const hostId = requireConnectedPrimaryHostId(deps);
  const result = await service.updateVoiceProfile(
    { serviceId: service.id, profileId, ...input },
    { hostId, timeoutMs: VOICE_CONTROL_HOST_DEADLINE_MS },
  );
  if (!result.ok) {
    mapVoiceControlFailure(result);
  }
  return { profile: toSystemVoiceProfile(result.profile) };
}

export async function deleteVoiceSpeechProfile(
  deps: LoggedWorkSessionDeps,
  profileId: string,
): Promise<void> {
  assertVoiceEnabled(deps);
  const service = requireVoiceService(deps);
  const hostId = requireConnectedPrimaryHostId(deps);
  const result = await service.deleteVoiceProfile(
    { serviceId: service.id, profileId },
    { hostId, timeoutMs: VOICE_CONTROL_HOST_DEADLINE_MS },
  );
  if (!result.ok) {
    mapVoiceControlFailure(result);
  }
}

export const VOICE_SAMPLE_MAX_BYTES = 25 * 1024 * 1024;

export async function addVoiceSpeechProfileSample(
  deps: LoggedWorkSessionDeps,
  profileId: string,
  file: File,
  referenceText: string,
): Promise<string> {
  if (file.size === 0) {
    throw new ApiError(400, "invalid_request", "Sample audio must not be empty");
  }
  if (file.size > VOICE_SAMPLE_MAX_BYTES) {
    throw new ApiError(
      400,
      "invalid_request",
      "Sample audio exceeds the 25MB limit",
    );
  }
  assertVoiceEnabled(deps);
  const service = requireVoiceService(deps);
  const hostId = requireConnectedPrimaryHostId(deps);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await service.addVoiceProfileSample(
    {
      serviceId: service.id,
      profileId,
      audioBase64: Buffer.from(bytes).toString("base64"),
      mimeType: file.type || "audio/wav",
      filename: file.name || "sample.wav",
      referenceText,
    },
    { hostId, timeoutMs: VOICE_CONTROL_HOST_DEADLINE_MS },
  );
  if (!result.ok) {
    mapVoiceControlFailure(result);
  }
  return result.sampleId;
}

export async function removeVoiceSpeechProfileSample(
  deps: LoggedWorkSessionDeps,
  sampleId: string,
): Promise<void> {
  assertVoiceEnabled(deps);
  const service = requireVoiceService(deps);
  const hostId = requireConnectedPrimaryHostId(deps);
  const result = await service.removeVoiceProfileSample(
    { serviceId: service.id, sampleId },
    { hostId, timeoutMs: VOICE_CONTROL_HOST_DEADLINE_MS },
  );
  if (!result.ok) {
    mapVoiceControlFailure(result);
  }
}

export async function downloadVoiceSpeechModel(
  deps: LoggedWorkSessionDeps,
  model: string,
): Promise<void> {
  assertVoiceEnabled(deps);
  const service = requireVoiceService(deps);
  const hostId = requireConnectedPrimaryHostId(deps);
  const result = await service.downloadVoiceModel(
    { serviceId: service.id, model },
    { hostId, timeoutMs: VOICE_CONTROL_HOST_DEADLINE_MS },
  );
  if (!result.ok) {
    mapVoiceControlFailure(result);
  }
}

export async function cancelVoiceSpeechModelDownload(
  deps: LoggedWorkSessionDeps,
  model: string,
): Promise<void> {
  assertVoiceEnabled(deps);
  const service = requireVoiceService(deps);
  const hostId = requireConnectedPrimaryHostId(deps);
  const result = await service.cancelVoiceModelDownload(
    { serviceId: service.id, model },
    { hostId, timeoutMs: VOICE_CONTROL_HOST_DEADLINE_MS },
  );
  if (!result.ok) {
    mapVoiceControlFailure(result);
  }
}

export async function repairVoiceSpeechRuntime(
  deps: LoggedWorkSessionDeps,
): Promise<void> {
  assertVoiceEnabled(deps);
  const service = requireVoiceService(deps);
  const hostId = requireConnectedPrimaryHostId(deps);
  const result = await service.repairVoiceRuntime(
    { serviceId: service.id },
    { hostId, timeoutMs: VOICE_CONTROL_HOST_DEADLINE_MS },
  );
  if (!result.ok) {
    mapVoiceControlFailure(result);
  }
}

export async function prepareVoiceSpeechRuntime(
  deps: LoggedWorkSessionDeps,
): Promise<{ runtimeState: "ready" | "starting" | "stopped" }> {
  assertVoiceEnabled(deps);
  const service = requireVoiceService(deps);
  const hostId = requireConnectedPrimaryHostId(deps);
  const result = await service.prepareVoiceRuntime(
    { serviceId: service.id },
    { hostId, timeoutMs: VOICE_CONTROL_HOST_DEADLINE_MS },
  );
  if (!result.ok) {
    mapVoiceControlFailure(result);
  }
  return { runtimeState: result.runtimeState };
}
