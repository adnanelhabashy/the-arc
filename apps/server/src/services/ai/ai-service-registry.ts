import type {
  ExperimentalAiInferenceCompleteInput,
  ExperimentalAiInferenceCompleteOutput,
  ExperimentalAiVoiceCapabilitiesInput,
  ExperimentalAiVoiceCapabilitiesOutput,
  ExperimentalAiVoiceModelDownloadInput,
  ExperimentalAiVoiceModelMutationOutput,
  ExperimentalAiVoicePrepareOutput,
  ExperimentalAiVoiceReleaseOutput,
  ExperimentalAiVoiceProfileCreateInput,
  ExperimentalAiVoiceProfileDeleteInput,
  ExperimentalAiVoiceProfileMutationOutput,
  ExperimentalAiVoiceProfileSampleAddInput,
  ExperimentalAiVoiceProfileSampleOutput,
  ExperimentalAiVoiceProfileSampleRemoveInput,
  ExperimentalAiVoiceProfileUpdateInput,
  ExperimentalAiVoiceProfilesInput,
  ExperimentalAiVoiceProfilesOutput,
  ExperimentalAiVoiceRepairInput,
  ExperimentalAiVoiceRepairOutput,
  ExperimentalAiVoiceSpeakInput,
  ExperimentalAiVoiceSpeakOutput,
  ExperimentalAiVoiceStatusInput,
  ExperimentalAiVoiceStatusOutput,
  ExperimentalAiVoiceTranscribeInput,
  ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import type { PluginAiServiceDeclaration } from "@get-bb/plugin-sdk";
import { aiServiceAlreadyRegisteredMessage } from "@get-bb/plugin-sdk/internal/host-policy";

export interface AiServiceCallOptions {
  hostId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AiServiceRegistration extends PluginAiServiceDeclaration {
  pluginId: string;
  completeInference(
    input: ExperimentalAiInferenceCompleteInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiInferenceCompleteOutput>;
  transcribeVoice(
    input: ExperimentalAiVoiceTranscribeInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceTranscribeOutput>;
  speakVoice(
    input: ExperimentalAiVoiceSpeakInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceSpeakOutput>;
  readVoiceStatus(
    input: ExperimentalAiVoiceStatusInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceStatusOutput>;
  readVoiceCapabilities(
    input: ExperimentalAiVoiceCapabilitiesInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceCapabilitiesOutput>;
  listVoiceProfiles(
    input: ExperimentalAiVoiceProfilesInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceProfilesOutput>;
  createVoiceProfile(
    input: ExperimentalAiVoiceProfileCreateInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceProfileMutationOutput>;
  updateVoiceProfile(
    input: ExperimentalAiVoiceProfileUpdateInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceProfileMutationOutput>;
  deleteVoiceProfile(
    input: ExperimentalAiVoiceProfileDeleteInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceProfileMutationOutput>;
  addVoiceProfileSample(
    input: ExperimentalAiVoiceProfileSampleAddInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceProfileSampleOutput>;
  removeVoiceProfileSample(
    input: ExperimentalAiVoiceProfileSampleRemoveInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceProfileSampleOutput>;
  downloadVoiceModel(
    input: ExperimentalAiVoiceModelDownloadInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceModelMutationOutput>;
  cancelVoiceModelDownload(
    input: ExperimentalAiVoiceModelDownloadInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceModelMutationOutput>;
  repairVoiceRuntime(
    input: ExperimentalAiVoiceRepairInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceRepairOutput>;
  prepareVoiceRuntime(
    input: ExperimentalAiVoiceRepairInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoicePrepareOutput>;
  releaseVoiceRuntime(
    input: ExperimentalAiVoiceRepairInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceReleaseOutput>;
  unloadVoiceModels(
    input: ExperimentalAiVoiceRepairInput,
    options: AiServiceCallOptions,
  ): Promise<ExperimentalAiVoiceModelMutationOutput>;
}

export interface AiServiceInfo extends PluginAiServiceDeclaration {
  pluginId: string;
}

export interface AiServiceRegistry {
  register(registration: AiServiceRegistration): { dispose(): void };
  get(id: string): AiServiceRegistration | null;
  list(): AiServiceInfo[];
}

export function createAiServiceRegistry(): AiServiceRegistry {
  const services = new Map<string, AiServiceRegistration>();
  return {
    register(registration) {
      if (services.has(registration.id)) {
        throw new Error(aiServiceAlreadyRegisteredMessage(registration.id));
      }
      services.set(registration.id, registration);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (services.get(registration.id) === registration) {
            services.delete(registration.id);
          }
        },
      };
    },
    get(id) {
      return services.get(id) ?? null;
    },
    list() {
      return [...services.values()].map((service) => ({
        id: service.id,
        displayName: service.displayName,
        kinds: service.kinds,
        pluginId: service.pluginId,
      }));
    },
  };
}
