/**
 * `@get-bb/plugin-sdk/ai-services` — the contract between bb's AI-services
 * feature (server-side helper inference: thread titles, commit messages;
 * voice transcription) and a plugin that serves them from a host.
 *
 * A plugin registers one or more services with
 * `bb.experimental_aiServices.register({ id, displayName, kinds })` in its
 * `server.ts`, and implements the methods below in its `bb.host` entry
 * (`experimental_defineHostEntry({ contract: experimental_aiServicesHostContract, ... })`).
 * Core routes the user's configured `BB_INFERENCE` / `BB_TRANSCRIPTION`
 * (`<serviceId>/<model>`) to the plugin that registered `serviceId` and calls
 * the method on the primary host. The `serviceId` travels on every call so one
 * plugin can serve several services from one host entry.
 *
 * Failures are part of the result, not thrown: a thrown error reaches core as
 * an opaque transport failure, while a `{ ok: false, code }` result lets core
 * apply its retry and fallback policy (timeouts and rate limits fall back to
 * the configured fallback model; auth failures do not).
 */
import { z } from "zod";
import { jsonObjectSchema } from "@bb/domain";
import { defineRpcContract } from "./rpc-contract.js";

/** Why a call did not produce a result; core's retry policy keys on it. */
export const experimental_aiServiceErrorCodeSchema = z.enum([
  /** The service did not answer within the request's `timeoutMs`. */
  "timeout",
  /** The upstream rejected the request for rate or quota reasons; retryable. */
  "rate_limited",
  /** The upstream is down or overloaded; retryable. */
  "service_unavailable",
  /** No usable credentials on this host; the user must sign in. Not retryable. */
  "auth_required",
  /** The upstream rejected the request (bad model, bad input, policy). Not retryable. */
  "request_failed",
  /** The upstream answered, but not with something that satisfies the request. */
  "invalid_response",
]);
export type ExperimentalAiServiceErrorCode = z.infer<
  typeof experimental_aiServiceErrorCodeSchema
>;

const failureSchema = z
  .object({
    ok: z.literal(false),
    code: experimental_aiServiceErrorCodeSchema,
    message: z.string().min(1),
  })
  .strict();

export const experimental_aiInferenceCompleteInputSchema = z
  .object({
    serviceId: z.string().min(1),
    /** The model segment of the user's `<serviceId>/<model>` setting. */
    model: z.string().min(1),
    /** Helper inference is short and latency-bound; no reasoning. */
    reasoningEffort: z.literal("none"),
    prompt: z.string().min(1),
    /** A JSON Schema object the structured result must satisfy. */
    outputSchema: jsonObjectSchema,
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type ExperimentalAiInferenceCompleteInput = z.infer<
  typeof experimental_aiInferenceCompleteInputSchema
>;

export const experimental_aiInferenceCompleteOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      model: z.string().min(1),
      value: jsonObjectSchema,
    })
    .strict(),
  failureSchema,
]);
export type ExperimentalAiInferenceCompleteOutput = z.infer<
  typeof experimental_aiInferenceCompleteOutputSchema
>;

export const experimental_aiVoiceTranscribeInputSchema = z
  .object({
    serviceId: z.string().min(1),
    model: z.string().min(1),
    language: z.string().nullable(),
    audioBase64: z.string().min(1),
    mimeType: z.string().min(1),
    filename: z.string().min(1),
    prompt: z.string().nullable(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type ExperimentalAiVoiceTranscribeInput = z.infer<
  typeof experimental_aiVoiceTranscribeInputSchema
>;

export const experimental_aiVoiceTranscribeOutputSchema = z.union([
  z
    .object({ ok: z.literal(true), model: z.string().min(1), text: z.string() })
    .strict(),
  failureSchema,
]);
export type ExperimentalAiVoiceTranscribeOutput = z.infer<
  typeof experimental_aiVoiceTranscribeOutputSchema
>;

export const experimental_aiVoiceStatusInputSchema = z
  .object({
    serviceId: z.string().min(1),
  })
  .strict();
export type ExperimentalAiVoiceStatusInput = z.infer<
  typeof experimental_aiVoiceStatusInputSchema
>;

/**
 * Whether the host's speech runtime is usable right now, for the states a
 * caller can show a user. `speechModelLoaded` answers "is a speech-to-text
 * model resident?"; `voiceModel` describes the text-to-speech model the host
 * would generate with, so a UI can distinguish "preparing the voice" from
 * "generating speech" without inventing progress.
 */
export const experimental_aiVoiceStatusOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      runtimeState: z.enum(["stopped", "starting", "ready"]),
      version: z.string().nullable(),
      speechModelLoaded: z.boolean(),
      voiceModel: z
        .object({
          engine: z.string().min(1),
          size: z.string(),
          downloaded: z.boolean(),
          loaded: z.boolean(),
          downloading: z.boolean(),
          /** Real download progress when the runtime reports it, else null. */
          downloadPercent: z.number().min(0).max(1).nullable(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  failureSchema,
]);
export type ExperimentalAiVoiceStatusOutput = z.infer<
  typeof experimental_aiVoiceStatusOutputSchema
>;

export const experimental_aiVoiceSpeakInputSchema = z
  .object({
    serviceId: z.string().min(1),
    text: z.string().min(1).max(1200),
    language: z.string().min(1).nullable(),
    profile: z.string().min(1).nullable(),
    engine: z.string().min(1).nullable(),
    voiceId: z.string().min(1).nullable(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type ExperimentalAiVoiceSpeakInput = z.infer<
  typeof experimental_aiVoiceSpeakInputSchema
>;

export const experimental_aiVoiceSpeakOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      audioBase64: z.string().min(1),
      contentType: z.string().min(1),
      durationMs: z.number().nonnegative().nullable(),
    })
    .strict(),
  failureSchema,
]);
export type ExperimentalAiVoiceSpeakOutput = z.infer<
  typeof experimental_aiVoiceSpeakOutputSchema
>;

export const experimental_voiceModelStateSchema = z
  .object({
    name: z.string().min(1),
    displayName: z.string().min(1),
    downloaded: z.boolean(),
    downloading: z.boolean(),
    loaded: z.boolean(),
    downloadPercent: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type ExperimentalVoiceModelState = z.infer<
  typeof experimental_voiceModelStateSchema
>;

export const experimental_voiceEngineCapabilitiesSchema = z
  .object({
    engine: z.string().min(1),
    requiresClonedProfile: z.boolean(),
    presets: z
      .array(
        z
          .object({
            voiceId: z.string().min(1),
            name: z.string().min(1),
            gender: z.string(),
            language: z.string().min(1),
          })
          .strict(),
      )
      .nullable(),
    models: z.array(experimental_voiceModelStateSchema),
  })
  .strict();
export type ExperimentalVoiceEngineCapabilities = z.infer<
  typeof experimental_voiceEngineCapabilitiesSchema
>;

export const experimental_aiVoiceCapabilitiesInputSchema = z
  .object({
    serviceId: z.string().min(1),
  })
  .strict();
export type ExperimentalAiVoiceCapabilitiesInput = z.infer<
  typeof experimental_aiVoiceCapabilitiesInputSchema
>;

export const experimental_aiVoiceCapabilitiesOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      runtimeState: z.enum(["stopped", "starting", "ready"]),
      version: z.string().nullable(),
      engines: z.array(experimental_voiceEngineCapabilitiesSchema),
      speechModels: z.array(experimental_voiceModelStateSchema),
    })
    .strict(),
  failureSchema,
]);
export type ExperimentalAiVoiceCapabilitiesOutput = z.infer<
  typeof experimental_aiVoiceCapabilitiesOutputSchema
>;

export const experimental_voiceProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable(),
    language: z.string().min(1),
    voiceType: z.string().min(1),
    presetEngine: z.string().nullable(),
    presetVoiceId: z.string().nullable(),
    sampleCount: z.number().int().nonnegative(),
  })
  .strict();
export type ExperimentalVoiceProfile = z.infer<
  typeof experimental_voiceProfileSchema
>;

const voiceServiceIdInputSchema = z
  .object({
    serviceId: z.string().min(1),
  })
  .strict();

export const experimental_aiVoiceProfilesInputSchema = voiceServiceIdInputSchema;
export type ExperimentalAiVoiceProfilesInput = z.infer<
  typeof experimental_aiVoiceProfilesInputSchema
>;

export const experimental_aiVoiceProfilesOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      profiles: z.array(experimental_voiceProfileSchema),
    })
    .strict(),
  failureSchema,
]);
export type ExperimentalAiVoiceProfilesOutput = z.infer<
  typeof experimental_aiVoiceProfilesOutputSchema
>;

export const experimental_aiVoiceProfileCreateInputSchema = z
  .object({
    serviceId: z.string().min(1),
    name: z.string().min(1).max(100),
    description: z.string().max(500).nullable(),
    language: z.string().min(1),
    voiceType: z.enum(["cloned", "preset", "designed"]),
    presetEngine: z.string().max(50).nullable(),
    presetVoiceId: z.string().nullable(),
  })
  .strict();
export type ExperimentalAiVoiceProfileCreateInput = z.infer<
  typeof experimental_aiVoiceProfileCreateInputSchema
>;

export const experimental_aiVoiceProfileUpdateInputSchema = z
  .object({
    serviceId: z.string().min(1),
    profileId: z.string().min(1),
    name: z.string().min(1).max(100).nullable(),
    description: z.string().max(500).nullable(),
  })
  .strict();
export type ExperimentalAiVoiceProfileUpdateInput = z.infer<
  typeof experimental_aiVoiceProfileUpdateInputSchema
>;

export const experimental_aiVoiceProfileDeleteInputSchema = z
  .object({
    serviceId: z.string().min(1),
    profileId: z.string().min(1),
  })
  .strict();
export type ExperimentalAiVoiceProfileDeleteInput = z.infer<
  typeof experimental_aiVoiceProfileDeleteInputSchema
>;

export const experimental_aiVoiceProfileMutationOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      profile: experimental_voiceProfileSchema,
    })
    .strict(),
  failureSchema,
]);
export type ExperimentalAiVoiceProfileMutationOutput = z.infer<
  typeof experimental_aiVoiceProfileMutationOutputSchema
>;

export const experimental_aiVoiceProfileSampleAddInputSchema = z
  .object({
    serviceId: z.string().min(1),
    profileId: z.string().min(1),
    audioBase64: z.string().min(1),
    mimeType: z.string().min(1),
    filename: z.string().min(1),
    referenceText: z.string().min(1).max(5000),
  })
  .strict();
export type ExperimentalAiVoiceProfileSampleAddInput = z.infer<
  typeof experimental_aiVoiceProfileSampleAddInputSchema
>;

export const experimental_aiVoiceProfileSampleRemoveInputSchema = z
  .object({
    serviceId: z.string().min(1),
    sampleId: z.string().min(1),
  })
  .strict();
export type ExperimentalAiVoiceProfileSampleRemoveInput = z.infer<
  typeof experimental_aiVoiceProfileSampleRemoveInputSchema
>;

export const experimental_aiVoiceProfileSampleOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      sampleId: z.string().min(1),
    })
    .strict(),
  failureSchema,
]);
export type ExperimentalAiVoiceProfileSampleOutput = z.infer<
  typeof experimental_aiVoiceProfileSampleOutputSchema
>;

export const experimental_aiVoiceModelDownloadInputSchema = z
  .object({
    serviceId: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();
export type ExperimentalAiVoiceModelDownloadInput = z.infer<
  typeof experimental_aiVoiceModelDownloadInputSchema
>;

export const experimental_aiVoiceModelMutationOutputSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  failureSchema,
]);
export type ExperimentalAiVoiceModelMutationOutput = z.infer<
  typeof experimental_aiVoiceModelMutationOutputSchema
>;

export const experimental_aiVoiceRepairInputSchema = voiceServiceIdInputSchema;
export type ExperimentalAiVoiceRepairInput = z.infer<
  typeof experimental_aiVoiceRepairInputSchema
>;

export const experimental_aiVoicePrepareOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      runtimeState: z.enum(["stopped", "starting", "ready"]),
    })
    .strict(),
  failureSchema,
]);
export type ExperimentalAiVoicePrepareOutput = z.infer<
  typeof experimental_aiVoicePrepareOutputSchema
>;

export const experimental_aiVoiceReleaseOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      runtimeState: z.enum(["stopped", "not-running"]),
    })
    .strict(),
  failureSchema,
]);
export type ExperimentalAiVoiceReleaseOutput = z.infer<
  typeof experimental_aiVoiceReleaseOutputSchema
>;

export const experimental_aiVoiceRepairOutputSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  failureSchema,
]);
export type ExperimentalAiVoiceRepairOutput = z.infer<
  typeof experimental_aiVoiceRepairOutputSchema
>;

/**
 * The host RPC methods an AI-service plugin implements. A plugin that
 * registers only `inference` still builds against the full contract; the
 * unregistered method may answer `{ ok: false, code: "request_failed" }`.
 */
export const experimental_aiServicesHostContract = defineRpcContract({
  "ai.inference.complete": {
    input: experimental_aiInferenceCompleteInputSchema,
    output: experimental_aiInferenceCompleteOutputSchema,
  },
  "ai.voice.transcribe": {
    input: experimental_aiVoiceTranscribeInputSchema,
    output: experimental_aiVoiceTranscribeOutputSchema,
  },
  "ai.voice.status": {
    input: experimental_aiVoiceStatusInputSchema,
    output: experimental_aiVoiceStatusOutputSchema,
  },
  "ai.voice.speak": {
    input: experimental_aiVoiceSpeakInputSchema,
    output: experimental_aiVoiceSpeakOutputSchema,
  },
  "ai.voice.capabilities": {
    input: experimental_aiVoiceCapabilitiesInputSchema,
    output: experimental_aiVoiceCapabilitiesOutputSchema,
  },
  "ai.voice.profiles": {
    input: experimental_aiVoiceProfilesInputSchema,
    output: experimental_aiVoiceProfilesOutputSchema,
  },
  "ai.voice.profileCreate": {
    input: experimental_aiVoiceProfileCreateInputSchema,
    output: experimental_aiVoiceProfileMutationOutputSchema,
  },
  "ai.voice.profileUpdate": {
    input: experimental_aiVoiceProfileUpdateInputSchema,
    output: experimental_aiVoiceProfileMutationOutputSchema,
  },
  "ai.voice.profileDelete": {
    input: experimental_aiVoiceProfileDeleteInputSchema,
    output: experimental_aiVoiceProfileMutationOutputSchema,
  },
  "ai.voice.profileSampleAdd": {
    input: experimental_aiVoiceProfileSampleAddInputSchema,
    output: experimental_aiVoiceProfileSampleOutputSchema,
  },
  "ai.voice.profileSampleRemove": {
    input: experimental_aiVoiceProfileSampleRemoveInputSchema,
    output: experimental_aiVoiceProfileSampleOutputSchema,
  },
  "ai.voice.modelDownload": {
    input: experimental_aiVoiceModelDownloadInputSchema,
    output: experimental_aiVoiceModelMutationOutputSchema,
  },
  "ai.voice.modelDownloadCancel": {
    input: experimental_aiVoiceModelDownloadInputSchema,
    output: experimental_aiVoiceModelMutationOutputSchema,
  },
  "ai.voice.repair": {
    input: experimental_aiVoiceRepairInputSchema,
    output: experimental_aiVoiceRepairOutputSchema,
  },
  "ai.voice.prepare": {
    input: experimental_aiVoiceRepairInputSchema,
    output: experimental_aiVoicePrepareOutputSchema,
  },
  "ai.voice.release": {
    input: experimental_aiVoiceRepairInputSchema,
    output: experimental_aiVoiceReleaseOutputSchema,
  },
  "ai.voice.unloadModels": {
    input: experimental_aiVoiceRepairInputSchema,
    output: experimental_aiVoiceModelMutationOutputSchema,
  },
});
export type ExperimentalAiServicesHostContract =
  typeof experimental_aiServicesHostContract;
