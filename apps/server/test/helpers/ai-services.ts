import type {
  ExperimentalAiInferenceCompleteInput,
  ExperimentalAiInferenceCompleteOutput,
  ExperimentalAiVoiceCapabilitiesInput,
  ExperimentalAiVoiceCapabilitiesOutput,
  ExperimentalAiVoiceProfileSampleAddInput,
  ExperimentalAiVoiceProfileSampleOutput,
  ExperimentalAiVoiceProfilesInput,
  ExperimentalAiVoiceProfilesOutput,
  ExperimentalAiVoiceReleaseOutput,
  ExperimentalAiVoiceModelMutationOutput,
  ExperimentalAiVoiceRepairInput,
  ExperimentalAiVoiceSpeakInput,
  ExperimentalAiVoiceSpeakOutput,
  ExperimentalAiVoiceStatusInput,
  ExperimentalAiVoiceStatusOutput,
  ExperimentalAiVoiceTranscribeInput,
  ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import type { PluginAiServiceKind } from "@get-bb/plugin-sdk";
import type {
  AiServiceCallOptions,
  AiServiceRegistry,
} from "../../src/services/ai/ai-service-registry.js";

export interface FakeAiServiceCall<Input> {
  input: Input;
  options: AiServiceCallOptions;
}

export function registerFakeAiService(
  registry: AiServiceRegistry,
  args: {
    id?: string;
    kinds?: readonly PluginAiServiceKind[];
    completeInference?: (
      input: ExperimentalAiInferenceCompleteInput,
    ) =>
      | ExperimentalAiInferenceCompleteOutput
      | Promise<ExperimentalAiInferenceCompleteOutput>;
    transcribeVoice?: (
      input: ExperimentalAiVoiceTranscribeInput,
    ) =>
      | ExperimentalAiVoiceTranscribeOutput
      | Promise<ExperimentalAiVoiceTranscribeOutput>;
    speakVoice?: (
      input: ExperimentalAiVoiceSpeakInput,
    ) =>
      | ExperimentalAiVoiceSpeakOutput
      | Promise<ExperimentalAiVoiceSpeakOutput>;
    readVoiceStatus?: (
      input: ExperimentalAiVoiceStatusInput,
    ) =>
      | ExperimentalAiVoiceStatusOutput
      | Promise<ExperimentalAiVoiceStatusOutput>;
    readVoiceCapabilities?: (
      input: ExperimentalAiVoiceCapabilitiesInput,
    ) =>
      | ExperimentalAiVoiceCapabilitiesOutput
      | Promise<ExperimentalAiVoiceCapabilitiesOutput>;
    listVoiceProfiles?: (
      input: ExperimentalAiVoiceProfilesInput,
    ) =>
      | ExperimentalAiVoiceProfilesOutput
      | Promise<ExperimentalAiVoiceProfilesOutput>;
    releaseVoiceRuntime?: (
      input: ExperimentalAiVoiceRepairInput,
    ) =>
      | ExperimentalAiVoiceReleaseOutput
      | Promise<ExperimentalAiVoiceReleaseOutput>;
    unloadVoiceModels?: (
      input: ExperimentalAiVoiceRepairInput,
    ) =>
      | ExperimentalAiVoiceModelMutationOutput
      | Promise<ExperimentalAiVoiceModelMutationOutput>;
    addVoiceProfileSample?: (
      input: ExperimentalAiVoiceProfileSampleAddInput,
    ) =>
      | ExperimentalAiVoiceProfileSampleOutput
      | Promise<ExperimentalAiVoiceProfileSampleOutput>;
  } = {},
): {
  inferenceCalls: FakeAiServiceCall<ExperimentalAiInferenceCompleteInput>[];
  voiceCalls: FakeAiServiceCall<ExperimentalAiVoiceTranscribeInput>[];
  speakCalls: FakeAiServiceCall<ExperimentalAiVoiceSpeakInput>[];
  statusCalls: FakeAiServiceCall<ExperimentalAiVoiceStatusInput>[];
  releaseCalls: FakeAiServiceCall<ExperimentalAiVoiceRepairInput>[];
  unloadCalls: FakeAiServiceCall<ExperimentalAiVoiceRepairInput>[];
  dispose(): void;
} {
  const inferenceCalls: FakeAiServiceCall<ExperimentalAiInferenceCompleteInput>[] =
    [];
  const voiceCalls: FakeAiServiceCall<ExperimentalAiVoiceTranscribeInput>[] =
    [];
  const speakCalls: FakeAiServiceCall<ExperimentalAiVoiceSpeakInput>[] = [];
  const releaseCalls: FakeAiServiceCall<ExperimentalAiVoiceRepairInput>[] = [];
  const unloadCalls: FakeAiServiceCall<ExperimentalAiVoiceRepairInput>[] = [];
  const statusCalls: FakeAiServiceCall<ExperimentalAiVoiceStatusInput>[] = [];
  const registration = registry.register({
    id: args.id ?? "codex",
    displayName: "Fake service",
    kinds: args.kinds ?? ["inference", "voice"],
    pluginId: "provider-fake",
    async completeInference(input, options) {
      inferenceCalls.push({ input, options });
      if (!args.completeInference) {
        throw new Error("fake AI service has no inference handler");
      }
      return args.completeInference(input);
    },
    async transcribeVoice(input, options) {
      voiceCalls.push({ input, options });
      if (!args.transcribeVoice) {
        throw new Error("fake AI service has no voice handler");
      }
      return args.transcribeVoice(input);
    },
    async speakVoice(input, options) {
      speakCalls.push({ input, options });
      if (!args.speakVoice) {
        throw new Error("fake AI service has no speak handler");
      }
      return args.speakVoice(input);
    },
    async readVoiceStatus(input, options) {
      statusCalls.push({ input, options });
      if (!args.readVoiceStatus) {
        throw new Error("fake AI service has no status handler");
      }
      return args.readVoiceStatus(input);
    },
    async readVoiceCapabilities(input, options) {
      void options;
      if (!args.readVoiceCapabilities) {
        throw new Error("fake AI service has no capabilities handler");
      }
      return args.readVoiceCapabilities(input);
    },
    async listVoiceProfiles(input, options) {
      void options;
      if (!args.listVoiceProfiles) {
        throw new Error("fake AI service has no profiles handler");
      }
      return args.listVoiceProfiles(input);
    },
    async addVoiceProfileSample(input, options) {
      void options;
      if (!args.addVoiceProfileSample) {
        throw new Error("fake AI service has no sample handler");
      }
      return args.addVoiceProfileSample(input);
    },
    async createVoiceProfile() {
      throw new Error("fake AI service has no profile handler");
    },
    async updateVoiceProfile() {
      throw new Error("fake AI service has no profile handler");
    },
    async deleteVoiceProfile() {
      throw new Error("fake AI service has no profile handler");
    },
    async removeVoiceProfileSample() {
      throw new Error("fake AI service has no sample handler");
    },
    async downloadVoiceModel() {
      throw new Error("fake AI service has no model handler");
    },
    async cancelVoiceModelDownload() {
      throw new Error("fake AI service has no model handler");
    },
    async repairVoiceRuntime() {
      throw new Error("fake AI service has no repair handler");
    },
    async prepareVoiceRuntime() {
      throw new Error("fake AI service has no prepare handler");
    },
    async releaseVoiceRuntime(input, options) {
      void options;
      releaseCalls.push({ input, options });
      if (!args.releaseVoiceRuntime) {
        throw new Error("fake AI service has no release handler");
      }
      return args.releaseVoiceRuntime(input);
    },
    async unloadVoiceModels(input, options) {
      void options;
      unloadCalls.push({ input, options });
      if (!args.unloadVoiceModels) {
        throw new Error("fake AI service has no unload handler");
      }
      return args.unloadVoiceModels(input);
    },
  });
  return {
    inferenceCalls,
    voiceCalls,
    speakCalls,
    statusCalls,
    releaseCalls,
    unloadCalls,
    dispose: registration.dispose,
  };
}
