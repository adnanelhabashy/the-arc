import { rejectMultipleWorkspaceSelectors } from "./shared.js";
import { z } from "zod";
import {
  appSettingsSchema,
  appDefaultKeybindingsSchema,
  appKeybindingOverridesSchema,
  appKeybindingsSchema,
  appThemeSchema,
  availableModelSchema,
  experimentsSchema,
  featureFlagsSchema,
  jsonValueSchema,
  permissionModeSchema,
  pluginThemeMetaSchema,
  providerInfoSchema,
} from "@bb/domain";
import { providerHealthSchema as providerHealthSchema } from "@bb/provider-bridge-protocol/provider-maintenance";
import { hostPlatformSchema } from "@bb/host-daemon-contract/local";
import { machineEnvironmentSetSchema } from "./machine-environment.js";

const machineEnvironmentReplacementVariableSchema =
  machineEnvironmentSetSchema.extend({
    value: machineEnvironmentSetSchema.shape.value.nullable(),
  });

export const machineEnvironmentReplaceSchema = z
  .object({
    variables: z.array(machineEnvironmentReplacementVariableSchema),
  })
  .strict()
  .superRefine(({ variables }, context) => {
    const names = new Set<string>();
    for (const [index, variable] of variables.entries()) {
      if (names.has(variable.name)) {
        context.addIssue({
          code: "custom",
          path: ["variables", index, "name"],
          message: "Machine environment variable names must be unique",
        });
      }
      names.add(variable.name);
    }
  });
export type MachineEnvironmentReplace = z.infer<
  typeof machineEnvironmentReplaceSchema
>;

export const systemExecutionOptionsModelLoadErrorCodeSchema = z.enum([
  "provider_unavailable",
  "missing_executable",
  "auth_required",
  "timeout",
  "failed",
]);
export type SystemExecutionOptionsModelLoadErrorCode = z.infer<
  typeof systemExecutionOptionsModelLoadErrorCodeSchema
>;

export const systemExecutionOptionsModelLoadErrorSchema = z.object({
  providerId: z.string().min(1),
  code: systemExecutionOptionsModelLoadErrorCodeSchema,
});
export type SystemExecutionOptionsModelLoadError = z.infer<
  typeof systemExecutionOptionsModelLoadErrorSchema
>;

export const systemExecutionOptionsResponseSchema = z.object({
  providers: z.array(providerInfoSchema),
  permissionCeiling: permissionModeSchema,
  models: z.array(availableModelSchema),
  selectedOnlyModels: z.array(availableModelSchema),
  modelLoadError: systemExecutionOptionsModelLoadErrorSchema.nullable(),
});
export type SystemExecutionOptionsResponse = z.infer<
  typeof systemExecutionOptionsResponseSchema
>;

const systemProviderHostQueryFields = {
  hostId: z.string().min(1),
  environmentId: z.string().min(1),
} as const;

export const systemProvidersQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    capability: z.enum(["usage"]),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type SystemProvidersQuery = z.infer<typeof systemProvidersQuerySchema>;

export const systemExecutionOptionsQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    providerId: z.string().min(1),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type SystemExecutionOptionsQuery = z.infer<
  typeof systemExecutionOptionsQuerySchema
>;

export const systemUsageLimitsQuerySchema = z.object({
  hostId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
});
export type SystemUsageLimitsQuery = z.infer<
  typeof systemUsageLimitsQuerySchema
>;

export interface SystemVoiceTranscriptionForm {
  [key: string]: string | Blob;
}

export { providerInfoSchema as systemProviderInfoSchema } from "@bb/domain";
export type { ProviderInfo as SystemProviderInfo } from "@bb/domain";

export const systemVoiceTranscriptionResponseSchema = z.object({
  text: z.string(),
});
export type SystemVoiceTranscriptionResponse = z.infer<
  typeof systemVoiceTranscriptionResponseSchema
>;

/**
 * What the Arc Voice runtime can do right now. The renderer polls this while a
 * dictation or a spoken reply is in flight so it can name the phase it is
 * actually in ("preparing the speech model" vs "transcribing locally",
 * "preparing the voice" vs "generating speech") instead of inventing progress.
 */
export const systemVoiceStatusResponseSchema = z.object({
  transcriptionEnabled: z.boolean(),
  voiceEnabled: z.boolean().default(true),
  speech: z.object({
    runtimeState: z.enum(["stopped", "starting", "ready", "unavailable"]),
    version: z.string().nullable(),
    speechModelLoaded: z.boolean(),
    voiceModel: z
      .object({
        engine: z.string(),
        size: z.string(),
        downloaded: z.boolean(),
        loaded: z.boolean(),
        downloading: z.boolean(),
        downloadPercent: z.number().nullable(),
      })
      .nullable(),
  }),
});
export type SystemVoiceStatusResponse = z.infer<
  typeof systemVoiceStatusResponseSchema
>;

export const systemVoiceSpeakRequestSchema = z.object({
  text: z.string().min(1).max(1200),
  engine: z.string().min(1).nullable().optional(),
  profile: z.string().min(1).nullable().optional(),
  voiceId: z.string().min(1).nullable().optional(),
  language: z.string().min(1).nullable().optional(),
  agentId: z.enum(["codex", "claude-code", "omp"]).nullable().optional(),
});
export type SystemVoiceSpeakRequest = z.infer<
  typeof systemVoiceSpeakRequestSchema
>;

export const systemVoiceModelStateSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  downloaded: z.boolean(),
  downloading: z.boolean(),
  loaded: z.boolean(),
  downloadPercent: z.number().nullable(),
});
export type SystemVoiceModelState = z.infer<typeof systemVoiceModelStateSchema>;

export const systemVoiceEngineCapabilitiesSchema = z.object({
  engine: z.string().min(1),
  requiresClonedProfile: z.boolean(),
  presets: z
    .array(
      z.object({
        voiceId: z.string().min(1),
        name: z.string().min(1),
        gender: z.string(),
        language: z.string().min(1),
      }),
    )
    .nullable(),
  models: z.array(systemVoiceModelStateSchema),
});
export type SystemVoiceEngineCapabilities = z.infer<
  typeof systemVoiceEngineCapabilitiesSchema
>;

export const systemVoiceCapabilitiesResponseSchema = z.object({
  voiceEnabled: z.boolean().default(true),
  runtimeState: z.enum(["stopped", "starting", "ready", "unavailable"]),
  version: z.string().nullable(),
  engines: z.array(systemVoiceEngineCapabilitiesSchema),
  speechModels: z.array(systemVoiceModelStateSchema),
});
export type SystemVoiceCapabilitiesResponse = z.infer<
  typeof systemVoiceCapabilitiesResponseSchema
>;

export const systemVoiceProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  language: z.string().min(1),
  voiceType: z.string().min(1),
  presetEngine: z.string().nullable(),
  presetVoiceId: z.string().nullable(),
  sampleCount: z.number().int().nonnegative(),
});
export type SystemVoiceProfile = z.infer<typeof systemVoiceProfileSchema>;

export const systemVoiceProfilesResponseSchema = z.object({
  voiceEnabled: z.boolean().default(true),
  profiles: z.array(systemVoiceProfileSchema),
});
export type SystemVoiceProfilesResponse = z.infer<
  typeof systemVoiceProfilesResponseSchema
>;

export const systemVoiceProfileCreateRequestSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable(),
  language: z.string().min(1),
  voiceType: z.enum(["cloned", "preset", "designed"]),
  presetEngine: z.string().max(50).nullable(),
  presetVoiceId: z.string().nullable(),
});
export type SystemVoiceProfileCreateRequest = z.infer<
  typeof systemVoiceProfileCreateRequestSchema
>;

export const systemVoiceProfileUpdateRequestSchema = z.object({
  name: z.string().min(1).max(100).nullable(),
  description: z.string().max(500).nullable(),
});
export type SystemVoiceProfileUpdateRequest = z.infer<
  typeof systemVoiceProfileUpdateRequestSchema
>;

export interface SystemVoiceProfileSampleAddForm {
  [key: string]: string | Blob;
}

export const systemVoiceModelRequestSchema = z.object({
  model: z.string().min(1),
});
export type SystemVoiceModelRequest = z.infer<
  typeof systemVoiceModelRequestSchema
>;

export const systemProviderStateSchema = providerHealthSchema.extend({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
});
export type SystemProviderState = z.infer<typeof systemProviderStateSchema>;

export const systemProviderStatesResponseSchema = z.object({
  providers: z.array(systemProviderStateSchema),
});
export type SystemProviderStatesResponse = z.infer<
  typeof systemProviderStatesResponseSchema
>;

export const systemAiServiceSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  kinds: z.array(z.enum(["inference", "voice"])),
  pluginId: z.string().min(1),
});

export const systemAiServicesSchema = z.object({
  inference: z.string().min(1),
  inferenceFallback: z.string().min(1),
  transcription: z.string().min(1),
  services: z.array(systemAiServiceSchema),
});

export const serverAccessStatusSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      description: z.string(),
      pluginId: z.string().min(1).nullable(),
      availability: z
        .discriminatedUnion("status", [
          z.object({
            status: z.literal("available"),
            serverUrl: z.string().url().optional(),
          }),
          z.object({
            status: z.literal("setup-required"),
            message: z.string(),
          }),
          z.object({ status: z.literal("unavailable"), message: z.string() }),
        ])
        .nullable(),
    }),
  ),
  defaultProviderId: z.string(),
  effectiveUrl: z.string().nullable(),
  urlSource: z.enum(["setting", "BB_EXTERNAL_URL"]).nullable(),
});
export type ServerAccessStatus = z.infer<typeof serverAccessStatusSchema>;

export const systemConfigResponseSchema = z.object({
  serverAccess: serverAccessStatusSchema,
  generalSettings: appSettingsSchema.extend({
    showUnhandledProviderEvents: z.boolean().optional(),
  }),
  keybindings: appKeybindingsSchema,
  defaultKeybindings: appDefaultKeybindingsSchema,
  keybindingOverrides: appKeybindingOverridesSchema,
  experiments: experimentsSchema,
  appearance: appThemeSchema,
  customThemes: z.array(z.string()),
  pluginThemes: z.array(pluginThemeMetaSchema),
  featureFlags: featureFlagsSchema,
  hostDaemonPort: z.number().nullable(),
  localHelperPorts: z.array(z.number().int().min(1).max(65_535)),
  serverUrl: z.string().url(),
  primaryHostId: z.string().nullable(),
  primaryHostPlatform: hostPlatformSchema.nullable(),
  voiceTranscriptionEnabled: z.boolean(),
  aiServices: systemAiServicesSchema,
  dataDir: z.string(),
});
export type SystemConfigResponse = z.infer<typeof systemConfigResponseSchema>;

export const systemAttentionResponseSchema = z.object({
  hasAttention: z.boolean(),
});
export type SystemAttentionResponse = z.infer<
  typeof systemAttentionResponseSchema
>;

export const themeCatalogResponseSchema = z.object({
  dir: z.string(),
  custom: z.array(z.string()),
  plugins: z.array(pluginThemeMetaSchema),
  active: appThemeSchema,
});
export type ThemeCatalogResponse = z.infer<typeof themeCatalogResponseSchema>;

export const systemVersionResponseSchema = z.object({
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  source: z.literal("npm"),
  updateAvailable: z.boolean(),
  isDevelopment: z.boolean(),
  upgradeCommand: z.string(),
});
export type SystemVersionResponse = z.infer<typeof systemVersionResponseSchema>;

export const systemVersionQuerySchema = z.object({
  force: z.enum(["true", "false"]).optional(),
});
export type SystemVersionQuery = z.infer<typeof systemVersionQuerySchema>;

export const systemConfigReloadResponseSchema = z.object({
  ok: z.literal(true),
});

export const cliSkillMachineStatusSchema = z.enum([
  "installed",
  "outdated",
  "missing",
  "unknown",
]);
export type CliSkillMachineStatus = z.infer<typeof cliSkillMachineStatusSchema>;

export const systemCliSkillsStatusQuerySchema = z.object({
  hostIds: z.string().optional(),
});
export type SystemCliSkillsStatusQuery = z.infer<
  typeof systemCliSkillsStatusQuerySchema
>;

export const systemCliSkillsStatusResponseSchema = z.object({
  machines: z.array(
    z.object({
      hostId: z.string(),
      hostName: z.string(),
      status: cliSkillMachineStatusSchema,
    }),
  ),
});
export type SystemCliSkillsStatusResponse = z.infer<
  typeof systemCliSkillsStatusResponseSchema
>;

export const systemInstallCliSkillsRequestSchema = z.object({
  hostIds: z.array(z.string().min(1)).min(1).max(64),
});
export type SystemInstallCliSkillsRequest = z.infer<
  typeof systemInstallCliSkillsRequestSchema
>;

export const systemInstallCliSkillsResponseSchema = z.object({
  results: z.array(
    z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        hostId: z.string(),
        hostName: z.string(),
        installations: z.array(
          z.object({
            name: z.string(),
            path: z.string(),
          }),
        ),
      }),
      z.object({
        ok: z.literal(false),
        hostId: z.string(),
        hostName: z.string(),
        errorMessage: z.string(),
      }),
    ]),
  ),
});
export type SystemInstallCliSkillsResponse = z.infer<
  typeof systemInstallCliSkillsResponseSchema
>;
export type SystemConfigReloadResponse = z.infer<
  typeof systemConfigReloadResponseSchema
>;

const systemEnvironmentProviderAvailabilitySchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("available") }),
    z.object({
      status: z.literal("setup-required"),
      message: z.string().min(1),
    }),
    z.object({
      status: z.literal("unavailable"),
      message: z.string().min(1),
    }),
  ],
);

export const systemEnvironmentProviderSchema = z.object({
  environmentProviderId: z.string().min(1).optional(),
  machineProviderId: z.string().min(1).nullable(),
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1).nullable(),
  icon: z.string().min(1).nullable(),
  logoUrl: z.string().min(1).nullable(),
  pluginId: z.string().min(1),
  requires: z.object({
    projectCheckout: z.boolean(),
    gitCheckout: z.boolean(),
    gitRemote: z.boolean(),
    projectless: z.boolean(),
  }),
  inputs: jsonValueSchema.nullable(),
  acceptsEmptyInputs: z.boolean(),
  availability: systemEnvironmentProviderAvailabilitySchema.nullable(),
  machineAvailability: z.record(
    z.string().min(1),
    systemEnvironmentProviderAvailabilitySchema.nullable(),
  ),
  machineInputs: jsonValueSchema.nullable().optional(),
  machineAcceptsEmptyInputs: z.boolean().optional(),
  machineProviderPluginId: z.string().min(1).optional(),
});
export type SystemEnvironmentProvider = z.infer<
  typeof systemEnvironmentProviderSchema
>;

export const systemEnvironmentProvidersResponseSchema = z.object({
  providers: z.array(systemEnvironmentProviderSchema),
});
export type SystemEnvironmentProvidersResponse = z.infer<
  typeof systemEnvironmentProvidersResponseSchema
>;

export const systemEnvironmentProvidersQuerySchema = z
  .object({
    projectId: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
  })
  .superRefine((query, context) => {
    if (query.hostId !== undefined && query.projectId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["hostId"],
        message: "hostId requires projectId",
      });
    }
  });
export type SystemEnvironmentProvidersQuery = z.infer<
  typeof systemEnvironmentProvidersQuerySchema
>;

export const systemMachineProviderSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  logoUrl: z.string().min(1).nullable(),
  pluginId: z.string().min(1),
  inputs: jsonValueSchema.nullable(),
  acceptsEmptyInputs: z.boolean(),
  supportsSuspend: z.boolean(),
});
export type SystemMachineProvider = z.infer<typeof systemMachineProviderSchema>;

export const systemMachineProvidersResponseSchema = z.object({
  providers: z.array(systemMachineProviderSchema),
});
export type SystemMachineProvidersResponse = z.infer<
  typeof systemMachineProvidersResponseSchema
>;
