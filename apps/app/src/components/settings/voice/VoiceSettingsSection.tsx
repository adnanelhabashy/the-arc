import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  VOICE_LANGUAGES,
  VOICE_STT_MODELS,
  VOICE_TTS_ENGINES,
  type VoiceSettings,
  VOICE_AGENT_KEYS,
  type VoiceAgentKey,
  type VoiceAgentSelection,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Switch } from "@bb/shared-ui/switch";
import { cn } from "@bb/shared-ui/lib/utils";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import type { SystemVoiceCapabilitiesResponse } from "@bb/server-contract";
import { appToast } from "@/components/ui/app-toast";
import {
  SettingsDetailRow,
  SettingsRowList,
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import {
  SETTINGS_DROPDOWN_CONTENT_CLASS,
  SETTINGS_DROPDOWN_TRIGGER_CLASS,
} from "@/components/settings/settings-dropdown";
import {
  addVoiceProfileSample,
  cancelVoiceModelDownload,
  deleteVoiceProfile,
  downloadVoiceModel,
  prepareVoiceRuntime,
  repairVoiceRuntime,
  updateVoiceProfile,
} from "@/lib/api";
import {
  useAudioInputDevices,
  type AudioInputDeviceOption,
} from "@/hooks/useAudioInputDevices";
import {
  useAudioInputDevicePreference,
  type PreferredAudioInputDeviceId,
} from "@/lib/audio-input-device-preference";
import { voiceLanguageLabel } from "./voice-language";
import {
  clampPlaybackSpeed,
  isKnownTtsEngine,
  reduceTtsSelection,
  resolveTtsAfterProfileDelete,
  resolveTtsSpeakVoice,
  type VoiceTtsSettings,
} from "./voice-selection";
import {
  CLONED_VOICE_ENGINE,
  findSpeechModel,
  resolveEngineDownloadModel,
} from "./voice-models";
import {
  useInvalidateVoiceData,
  useVoiceCapabilities,
  useVoiceProfiles,
} from "./use-voice-data";
import {
  invalidateVoiceCapabilities,
  invalidateVoiceProfiles,
} from "@/hooks/cache-owners/system-cache-effects";
import { useVoicePreview, VOICE_PREVIEW_PHRASE } from "./use-voice-preview";
import { useMicrophoneTest } from "./use-microphone-test";
import { VoiceModelDownloadControl } from "./VoiceModelDownloadControl";
import { ProgressBar } from "./ProgressBar";
import { VoiceGallery } from "./VoiceGallery";
import { MyVoices } from "./MyVoices";
import { CreateCustomVoiceDialog } from "./CreateCustomVoiceDialog";

const STT_MODEL_LABELS: Readonly<Record<string, string>> = {
  "whisper-base": "Base",
  "whisper-small": "Small",
  "whisper-medium": "Medium",
  "whisper-large": "Large",
  "whisper-turbo": "Turbo",
};

const ENGINE_LABELS: Readonly<Record<string, string>> = {
  kokoro: "Kokoro",
  qwen: "Qwen",
  qwen_custom_voice: "Qwen custom voice",
};

const KNOWN_ENGINES = new Set<string>(VOICE_TTS_ENGINES);

function sttModelLabel(model: string): string {
  return STT_MODEL_LABELS[model] ?? model;
}

function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine;
}

const EMPTY_CAPABILITIES: SystemVoiceCapabilitiesResponse = {
  voiceEnabled: true,
  runtimeState: "unavailable",
  version: null,
  engines: [],
  speechModels: [],
};

interface MicrophonePickerProps {
  devices: readonly AudioInputDeviceOption[];
  isSupported: boolean;
  preferredDeviceId: PreferredAudioInputDeviceId;
  onDeviceChange: (deviceId: PreferredAudioInputDeviceId) => void;
  onRefresh: () => void;
}

function MicrophonePicker({
  devices,
  isSupported,
  preferredDeviceId,
  onDeviceChange,
  onRefresh,
}: MicrophonePickerProps) {
  const triggerLabel =
    preferredDeviceId === null
      ? "System default"
      : (devices.find((device) => device.deviceId === preferredDeviceId)
          ?.label ?? "Unavailable microphone");

  return (
    <DropdownMenu onOpenChange={(open) => {
      if (open) {
        onRefresh();
      }
    }}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
          aria-label="Microphone"
          disabled={!isSupported}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon name="Mic" className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{triggerLabel}</span>
          </span>
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={SETTINGS_DROPDOWN_CONTENT_CLASS}
        mobileTitle="Microphone"
      >
        <DropdownMenuItem onSelect={() => onDeviceChange(null)}>
          System default
          <Icon
            name="Check"
            className={cn(
              "ml-auto",
              preferredDeviceId !== null && "opacity-0",
              COARSE_POINTER_ICON_SIZE_CLASS,
            )}
          />
        </DropdownMenuItem>
        {devices.length > 0 ? <DropdownMenuSeparator /> : null}
        {devices.map((device) => (
          <DropdownMenuItem
            key={device.deviceId}
            onSelect={() => onDeviceChange(device.deviceId)}
          >
            <span className="min-w-0 truncate">{device.label}</span>
            <Icon
              name="Check"
              className={cn(
                "ml-auto",
                preferredDeviceId !== device.deviceId && "opacity-0",
                COARSE_POINTER_ICON_SIZE_CLASS,
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface VoiceSettingsSectionProps {
  voice: VoiceSettings;
  disabled: boolean;
  onVoiceChange: (voice: VoiceSettings) => void;
}

export function VoiceSettingsSection({
  voice,
  disabled,
  onVoiceChange,
}: VoiceSettingsSectionProps) {
  const queryClient = useQueryClient();
  const capabilitiesQuery = useVoiceCapabilities();
  const profilesQuery = useVoiceProfiles();
  const invalidateVoiceData = useInvalidateVoiceData();
  const preview = useVoicePreview();
  const micTest = useMicrophoneTest();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [preferredDeviceId, setPreferredDeviceId] =
    useAudioInputDevicePreference();
  const micDevices = useAudioInputDevices();

  const capabilities = capabilitiesQuery.data;
  const profiles = profilesQuery.data?.profiles ?? [];
  const tts = voice.tts;

  const engines = useMemo(
    () =>
      (capabilities?.engines ?? []).filter((engine) =>
        KNOWN_ENGINES.has(engine.engine),
      ),
    [capabilities],
  );

  const speechModelOptions = useMemo(
    () =>
      VOICE_STT_MODELS.filter((model) =>
        capabilities?.speechModels.some((state) => state.name === model),
      ),
    [capabilities],
  );

  const selectedSpeechModel = capabilities
    ? findSpeechModel(capabilities, voice.stt.model)
    : undefined;

  const selectedEngineCaps = capabilities
    ? (capabilities.engines.find((engine) => engine.engine === tts.engine) ??
      undefined)
    : undefined;

  const selectedProfile = tts.profileId
    ? (profiles.find((profile) => profile.id === tts.profileId) ?? null)
    : null;

  const repairMutation = useMutation({
    mutationFn: () => repairVoiceRuntime(),
    onSuccess: () => {
      appToast.success("Voice runtime repaired");
      invalidateVoiceData();
    },
    onError: () => {
      appToast.error("Voice repair failed");
    },
  });

  const downloadMutation = useMutation({
    mutationFn: (model: string) => downloadVoiceModel(model),
    onSuccess: () => {
      invalidateVoiceCapabilities({ queryClient });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (model: string) => cancelVoiceModelDownload(model),
    onSuccess: () => {
      invalidateVoiceCapabilities({ queryClient });
    },
  });

  const renameMutation = useMutation({
    mutationFn: (args: { profileId: string; name: string }) =>
      updateVoiceProfile(args.profileId, { name: args.name, description: null }),
    onSuccess: () => {
      invalidateVoiceProfiles({ queryClient });
    },
  });

  const addSampleMutation = useMutation({
    mutationFn: (args: {
      profileId: string;
      file: File;
      referenceText: string;
    }) =>
      addVoiceProfileSample(args.profileId, args.file, args.referenceText),
    onSuccess: () => {
      invalidateVoiceProfiles({ queryClient });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (profileId: string) => deleteVoiceProfile(profileId),
    onSuccess: (_result, profileId) => {
      invalidateVoiceProfiles({ queryClient });
      const nextTts = resolveTtsAfterProfileDelete(tts, profileId);
      if (nextTts !== tts) {
        onVoiceChange({ ...voice, tts: nextTts });
        appToast.message("Default voice reset to Kokoro", {
          description:
            "The deleted voice was your default. Arc now uses the Kokoro preset.",
        });
      }
    },
  });

  const onSelectPreset = (engine: string, voiceId: string) => {
    if (!isKnownTtsEngine(engine)) {
      return;
    }
    onVoiceChange({
      ...voice,
      tts: reduceTtsSelection(tts, { type: "preset", engine, presetVoiceId: voiceId }),
    });
  };

  const onSelectProfile = (profileId: string) => {
    onVoiceChange({
      ...voice,
      tts: reduceTtsSelection(tts, { type: "profile", profileId }),
    });
  };

  const agentVoiceProfiles = useMemo(
    () => profiles.filter((profile) => profile.voiceType !== "preset"),
    [profiles],
  );

  const setAgentVoice = (
    key: VoiceAgentKey,
    selection: VoiceAgentSelection | null,
  ) => {
    onVoiceChange({
      ...voice,
      agentVoices: { ...voice.agentVoices, [key]: selection },
    });
  };

  const agentVoiceLabel = (selection: VoiceAgentSelection): string => {
    if (selection.voiceKind === "profile") {
      const profile = profiles.find(
        (entry) => entry.id === selection.profileId,
      );
      return profile?.name ?? "Unavailable voice (using default)";
    }
    const engine = engines.find(
      (entry) => entry.engine === selection.presetEngine,
    );
    const preset = engine?.presets?.find(
      (entry) => entry.voiceId === selection.presetVoiceId,
    );
    return preset?.name ?? selection.presetVoiceId ?? "Unknown preset";
  };

  const speakVoice = resolveTtsSpeakVoice(
    tts,
    selectedProfile?.name ?? null,
  );

  const ttsPreviewing = preview.activeKey === "tts-selection" && preview.phase !== "idle";

  const selectedEngineModel =
    selectedEngineCaps === undefined
      ? null
      : resolveEngineDownloadModel(selectedEngineCaps);
  const selectedEngineReady =
    selectedEngineCaps === undefined ||
    selectedEngineCaps.models.some((model) => model.downloaded);

  const runtimeState = capabilities?.runtimeState ?? "unavailable";

  return (
    <div className="space-y-10">
      <SettingsSection
        title="Voice"
        description="Use local speech recognition and speech generation."
      >
        <SettingsWithControl
          label="Enable Arc Voice"
          description="Turn off to release the voice runtime, loaded models, and all voice activity."
        >
          <Switch
            checked={voice.enabled}
            disabled={disabled}
            aria-label="Enable Arc Voice"
            onCheckedChange={(enabled) => onVoiceChange({ ...voice, enabled })}
          />
        </SettingsWithControl>
        {!voice.enabled ? (
          <p className="text-sm text-muted-foreground">
            Voice is disabled. Speak, dictation, previews, and the voice runtime
            are unavailable until you enable it again. Your voice assignments
            are kept.
          </p>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Runtime"
        description={`Arc Voice runtime is ${voice.enabled ? runtimeState : "disabled"}.`}
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !voice.enabled || repairMutation.isPending}
            onClick={() => repairMutation.mutate()}
          >
            {repairMutation.isPending ? "Repairing…" : "Repair"}
          </Button>
        }
      >
        <SettingsRowList>
          <SettingsDetailRow label="Status">
            {runtimeState}
          </SettingsDetailRow>
          <SettingsDetailRow label="Version">
            {capabilities?.version ?? "Unknown"}
          </SettingsDetailRow>
        </SettingsRowList>
      </SettingsSection>

      <SettingsSection
        title="Speech to Text"
        description="Configure the local Whisper model used to transcribe dictation."
      >
        <SettingsRowList>
          <SettingsDetailRow label="Engine">
            Whisper (local)
          </SettingsDetailRow>
          <SettingsDetailRow label="Model">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                  aria-label="Speech to text model"
                  disabled={disabled}
                >
                  <span className="min-w-0 truncate">
                    {sttModelLabel(voice.stt.model)}
                  </span>
                  <Icon
                    name="ChevronDown"
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={SETTINGS_DROPDOWN_CONTENT_CLASS}
                mobileTitle="Speech to text model"
              >
                {speechModelOptions.map((model) => (
                  <DropdownMenuItem
                    key={model}
                    onSelect={() =>
                      onVoiceChange({ ...voice, stt: { ...voice.stt, model } })
                    }
                  >
                    {sttModelLabel(model)}
                    <Icon
                      name="Check"
                      className={cn(
                        "ml-auto",
                        voice.stt.model !== model && "opacity-0",
                        COARSE_POINTER_ICON_SIZE_CLASS,
                      )}
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {selectedSpeechModel !== undefined &&
            !selectedSpeechModel.downloaded ? (
              <VoiceModelDownloadControl
                modelName={selectedSpeechModel.name}
                downloading={selectedSpeechModel.downloading}
                downloadPercent={selectedSpeechModel.downloadPercent}
                onDownload={() => downloadMutation.mutate(selectedSpeechModel.name)}
                onCancel={() => cancelMutation.mutate(selectedSpeechModel.name)}
              />
            ) : null}
          </SettingsDetailRow>
          <SettingsDetailRow label="Language">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                  aria-label="Speech to text language"
                  disabled={disabled}
                >
                  <span className="min-w-0 truncate">
                    {voiceLanguageLabel(voice.stt.language)}
                  </span>
                  <Icon
                    name="ChevronDown"
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={SETTINGS_DROPDOWN_CONTENT_CLASS}
                mobileTitle="Speech to text language"
              >
                {VOICE_LANGUAGES.map((language) => (
                  <DropdownMenuItem
                    key={language}
                    onSelect={() =>
                      onVoiceChange({
                        ...voice,
                        stt: { ...voice.stt, language },
                      })
                    }
                  >
                    {voiceLanguageLabel(language)}
                    <Icon
                      name="Check"
                      className={cn(
                        "ml-auto",
                        voice.stt.language !== language && "opacity-0",
                        COARSE_POINTER_ICON_SIZE_CLASS,
                      )}
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsDetailRow>
        </SettingsRowList>
      </SettingsSection>

      <SettingsSection title="Microphone">
        <SettingsWithControl
          label="Microphone"
          description={
            micDevices.errorMessage ??
            "Used for prompt voice input and custom voice recording."
          }
        >
          <MicrophonePicker
            devices={micDevices.devices}
            isSupported={micDevices.isSupported}
            preferredDeviceId={preferredDeviceId}
            onDeviceChange={setPreferredDeviceId}
            onRefresh={() => {
              void micDevices.refresh({ requestPermission: true });
            }}
          />
        </SettingsWithControl>
        <SettingsWithControl
          label="Test microphone"
          description="Record a short clip and play it back locally."
          controlPlacement="below"
        >
          <div className="flex items-center gap-3">
            {micTest.state === "testing" ? (
              <>
                <ProgressBar
                  value={micTest.level * 100}
                  className="flex-1"
                  aria-label="Microphone level"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => micTest.stop()}
                >
                  Stop
                </Button>
              </>
            ) : micTest.state === "playing" ? (
              <span className="text-xs text-subtle-foreground">
                Playing back…
              </span>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void micTest.start()}
              >
                Test microphone
              </Button>
            )}
            {micTest.errorMessage !== null ? (
              <span className="text-xs text-destructive">
                {micTest.errorMessage}
              </span>
            ) : null}
          </div>
        </SettingsWithControl>
        <SettingsWithControl
          label="Reduce background noise"
          description="Apply echo cancellation and noise suppression while recording."
        >
          <Switch
            checked={voice.input.reduceBackgroundNoise}
            disabled={disabled}
            aria-label="Reduce background noise"
            onCheckedChange={(reduceBackgroundNoise) =>
              onVoiceChange({
                ...voice,
                input: { ...voice.input, reduceBackgroundNoise },
              })
            }
          />
        </SettingsWithControl>
      </SettingsSection>

      <SettingsSection
        title="Text to Speech"
        description="Choose the engine and voice Arc uses to read replies."
      >
        <SettingsRowList>
          <SettingsDetailRow label="Engine">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                  aria-label="Text to speech engine"
                  disabled={disabled}
                >
                  <span className="min-w-0 truncate">
                    {engineLabel(tts.engine)}
                  </span>
                  <Icon
                    name="ChevronDown"
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={SETTINGS_DROPDOWN_CONTENT_CLASS}
                mobileTitle="Text to speech engine"
              >
                {engines.map((engine) => (
                  <DropdownMenuItem
                    key={engine.engine}
                    onSelect={() =>
                      onVoiceChange({
                        ...voice,
                        tts: reduceTtsSelection(tts, {
                          type: "engine",
                          engine: engine.engine as VoiceTtsSettings["engine"],
                          caps: engine,
                        }),
                      })
                    }
                  >
                    {engineLabel(engine.engine)}
                    <Icon
                      name="Check"
                      className={cn(
                        "ml-auto",
                        tts.engine !== engine.engine && "opacity-0",
                        COARSE_POINTER_ICON_SIZE_CLASS,
                      )}
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsDetailRow>
          {tts.engine === "qwen" ? (
            <SettingsDetailRow label="Voice">
              <span className="text-xs text-subtle-foreground">
                Qwen speaks through a cloned voice — create one in My Voices.
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  document
                    .getElementById("voice-my-voices")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                Go to My Voices
              </Button>
            </SettingsDetailRow>
          ) : null}
          {selectedEngineModel !== null && !selectedEngineReady ? (
            <SettingsDetailRow label="Model">
              <VoiceModelDownloadControl
                modelName={selectedEngineModel.name}
                downloading={selectedEngineModel.downloading}
                downloadPercent={selectedEngineModel.downloadPercent}
                onDownload={() => downloadMutation.mutate(selectedEngineModel.name)}
                onCancel={() => cancelMutation.mutate(selectedEngineModel.name)}
              />
            </SettingsDetailRow>
          ) : null}
          {tts.voiceKind === "profile" && selectedProfile === null ? (
            <SettingsDetailRow label="Voice">
              <span className="text-xs text-destructive">
                Selected voice is unavailable. Choose another voice.
              </span>
            </SettingsDetailRow>
          ) : null}
        </SettingsRowList>

        <div className="mt-4 flex items-center justify-between gap-4">
          <SettingsWithControl
            label="Playback speed"
            description={`${tts.playbackSpeed.toFixed(2)}× speed`}
          >
            <div className="flex w-full items-center gap-3 sm:w-44">
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={tts.playbackSpeed}
                disabled={disabled}
                onChange={(event) =>
                  onVoiceChange({
                    ...voice,
                    tts: {
                      ...tts,
                      playbackSpeed: clampPlaybackSpeed(
                        Number(event.target.value),
                      ),
                    },
                  })
                }
                aria-label="Playback speed"
                className="w-full accent-foreground"
              />
            </div>
          </SettingsWithControl>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || (selectedEngineModel !== null && !selectedEngineReady)}
            onClick={() => {
              if (ttsPreviewing) {
                preview.stop();
                return;
              }
              preview.start(
                {
                  key: "tts-selection",
                  text: VOICE_PREVIEW_PHRASE,
                  engine: speakVoice.engine,
                  profile: speakVoice.profile,
                  presetVoiceId: speakVoice.presetVoiceId,
                },
                tts.playbackSpeed,
              );
            }}
          >
            <Icon
              name={ttsPreviewing ? "Square" : "Play"}
              className="size-3.5 shrink-0"
            />
            {ttsPreviewing ? "Stop" : "Preview"}
          </Button>
        </div>
      </SettingsSection>

      <VoiceGallery
        capabilities={capabilities ?? EMPTY_CAPABILITIES}
        tts={tts}
        preview={preview}
        playbackSpeed={tts.playbackSpeed}
        onSelectPreset={onSelectPreset}
        onDownloadModel={(model) => downloadMutation.mutate(model)}
        onCancelModel={(model) => cancelMutation.mutate(model)}
      />

      <div id="voice-my-voices">
        <MyVoices
          capabilities={capabilities ?? EMPTY_CAPABILITIES}
          profiles={profiles}
          tts={tts}
          preview={preview}
          playbackSpeed={tts.playbackSpeed}
          onCreate={() => setCreateOpen(true)}
          onSelectProfile={onSelectProfile}
          onRename={(profileId, name) => renameMutation.mutate({ profileId, name })}
          onAddSample={(profileId, file, referenceText) =>
            addSampleMutation.mutate({ profileId, file, referenceText })
          }
          onDelete={(profileId) => deleteMutation.mutate(profileId)}
          onDownloadModel={(model) => downloadMutation.mutate(model)}
          onCancelModel={(model) => cancelMutation.mutate(model)}
        />
      </div>

      <SettingsSection
        title="Agent Voices"
        description="Give each Arc agent its own voice. Unset agents use your default voice above."
      >
        <SettingsRowList>
          {VOICE_AGENT_KEYS.map((agentKey) => {
            const selection = voice.agentVoices[agentKey];
            const previewKey = `agent-voice:${agentKey}`;
            const previewing =
              preview.activeKey === previewKey && preview.phase !== "idle";
            const selectionProfile =
              selection?.voiceKind === "profile" && selection.profileId !== null
                ? (profiles.find(
                    (entry) => entry.id === selection.profileId,
                  ) ?? null)
                : null;
            return (
              <SettingsDetailRow
                key={agentKey}
                label={
                  agentKey === "claude-code"
                    ? "Claude Code"
                    : agentKey === "omp"
                      ? "OMP"
                      : "Codex"
                }
              >
                <div className="flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                        aria-label={`Voice for ${agentKey}`}
                        disabled={disabled}
                      >
                        <span className="min-w-0 truncate">
                          {selection === null
                            ? "Default voice"
                            : agentVoiceLabel(selection)}
                        </span>
                        <Icon
                          name="ChevronDown"
                          className="size-3.5 text-muted-foreground"
                        />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className={SETTINGS_DROPDOWN_CONTENT_CLASS}
                      mobileTitle={`Voice for ${agentKey}`}
                    >
                      <DropdownMenuItem
                        onSelect={() => setAgentVoice(agentKey, null)}
                      >
                        Default voice
                      </DropdownMenuItem>
                      {engines.map((engine) =>
                        engine.presets === null || engine.presets.length === 0 ? null : (
                          <DropdownMenuSub key={`${agentKey}:${engine.engine}`}>
                            <DropdownMenuSubTrigger>
                              {engineLabel(engine.engine)} presets
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className={SETTINGS_DROPDOWN_CONTENT_CLASS}>
                              {engine.presets.map((preset) => (
                                <DropdownMenuItem
                                  key={`${agentKey}:${engine.engine}:${preset.voiceId}`}
                                  onSelect={() =>
                                    setAgentVoice(agentKey, {
                                      engine:
                                        engine.engine as VoiceAgentSelection["engine"],
                                      voiceKind: "preset",
                                      presetEngine: engine.engine,
                                      presetVoiceId: preset.voiceId,
                                      profileId: null,
                                    })
                                  }
                                >
                                  {preset.name}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        ),
                      )}
                      {agentVoiceProfiles.length > 0 ? (
                        agentVoiceProfiles.map((profile) => (
                          <DropdownMenuItem
                            key={`${agentKey}:${profile.id}`}
                            onSelect={() =>
                              setAgentVoice(agentKey, {
                                engine:
                                  CLONED_VOICE_ENGINE as VoiceAgentSelection["engine"],
                                voiceKind: "profile",
                                presetEngine: CLONED_VOICE_ENGINE,
                                presetVoiceId: null,
                                profileId: profile.id,
                              })
                            }
                          >
                            {profile.name}
                          </DropdownMenuItem>
                        ))
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled || selection === null}
                    onClick={() => {
                      if (previewing) {
                        preview.stop();
                        return;
                      }
                      if (selection === null) return;
                      if (selection.voiceKind === "profile") {
                        if (selectionProfile === null) return;
                        preview.start(
                          {
                            key: previewKey,
                            text: VOICE_PREVIEW_PHRASE,
                            engine: CLONED_VOICE_ENGINE,
                            profile: selectionProfile.name,
                          },
                          tts.playbackSpeed,
                        );
                        return;
                      }
                      preview.start(
                        {
                          key: previewKey,
                          text: VOICE_PREVIEW_PHRASE,
                          engine: selection.presetEngine,
                          presetVoiceId: selection.presetVoiceId ?? undefined,
                        },
                        tts.playbackSpeed,
                      );
                    }}
                  >
                    <Icon name={previewing ? "Square" : "Play"} className="size-3.5" />
                    {previewing ? "Stop" : "Preview"}
                  </Button>
                </div>
              </SettingsDetailRow>
            );
          })}
        </SettingsRowList>
        <p className="text-sm text-muted-foreground">
          Preset choices open with the first voice in that engine; fine-grained
          preset browsing lives in the Voice Gallery above. Custom voices come
          from My Voices.
        </p>
      </SettingsSection>

      <SettingsSection title="Behavior">
        <SettingsWithControl
          label="Show microphone in composer"
          description="Display the voice input button when composing."
        >
          <Switch
            checked={voice.behavior.showMicrophone}
            disabled={disabled}
            aria-label="Show microphone in composer"
            onCheckedChange={(showMicrophone) =>
              onVoiceChange({
                ...voice,
                behavior: { ...voice.behavior, showMicrophone },
              })
            }
          />
        </SettingsWithControl>
        <SettingsWithControl
          label="Automatically speak replies"
          description="Start reading completed replies without pressing Speak."
        >
          <Switch
            checked={voice.behavior.autoSpeakReplies}
            disabled={disabled}
            aria-label="Automatically speak replies"
            onCheckedChange={(autoSpeakReplies) =>
              onVoiceChange({
                ...voice,
                behavior: { ...voice.behavior, autoSpeakReplies },
              })
            }
          />
        </SettingsWithControl>
        <SettingsWithControl
          label="Keep voice runtime warm"
          description="Prepare the voice runtime when enabled."
        >
          <Switch
            checked={voice.behavior.keepWarm}
            disabled={disabled || !voice.enabled}
            aria-label="Keep voice runtime warm"
            onCheckedChange={(keepWarm) => {
              onVoiceChange({
                ...voice,
                behavior: { ...voice.behavior, keepWarm },
              });
              if (keepWarm && voice.enabled) {
                void prepareVoiceRuntime().catch(() => undefined);
              }
            }}
          />
        </SettingsWithControl>
        <SettingsWithControl
          label="Unload models after use"
          description="Release voice models from memory after each speak or dictation. Slightly slower next response, much smaller memory footprint."
        >
          <Switch
            checked={voice.behavior.releaseModelsAfterUse}
            disabled={disabled}
            aria-label="Unload models after use"
            onCheckedChange={(releaseModelsAfterUse) =>
              onVoiceChange({
                ...voice,
                behavior: { ...voice.behavior, releaseModelsAfterUse },
              })
            }
          />
        </SettingsWithControl>
      </SettingsSection>

      <SettingsSection title="Advanced">
        <button
          type="button"
          className="flex w-full items-center justify-between text-sm text-foreground"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span>Engine and model details</span>
          <Icon
            name={advancedOpen ? "ChevronUp" : "ChevronDown"}
            className="size-4 text-muted-foreground"
          />
        </button>
        {advancedOpen ? (
          <SettingsRowList>
            <SettingsDetailRow label="Runtime version">
              {capabilities?.version ?? "Unknown"}
            </SettingsDetailRow>
            <SettingsDetailRow label="Selected engine">
              {tts.engine}
            </SettingsDetailRow>
            <SettingsDetailRow label="Voice kind">
              {tts.voiceKind}
            </SettingsDetailRow>
            <SettingsDetailRow label="Preset engine">
              {tts.presetEngine}
            </SettingsDetailRow>
            <SettingsDetailRow label="Preset voice id">
              {tts.presetVoiceId}
            </SettingsDetailRow>
            <SettingsDetailRow label="Profile id">
              {tts.profileId ?? "—"}
            </SettingsDetailRow>
            {engines.map((engine) => (
              <SettingsDetailRow key={engine.engine} label={engineLabel(engine.engine)}>
                {engine.models.map((model) => (
                  <span key={model.name} className="text-xs">
                    {model.name} ·{" "}
                    {model.downloaded
                      ? "downloaded"
                      : model.downloading
                        ? `downloading ${model.downloadPercent !== null ? `${Math.round(model.downloadPercent)}%` : ""}`
                        : "not downloaded"}
                    {model.loaded ? " · loaded" : ""}
                  </span>
                ))}
              </SettingsDetailRow>
            ))}
          </SettingsRowList>
        ) : null}
      </SettingsSection>

      <CreateCustomVoiceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        capabilities={capabilities ?? EMPTY_CAPABILITIES}
        preview={preview}
        playbackSpeed={tts.playbackSpeed}
        onDownloadModel={(model) => downloadMutation.mutate(model)}
        onCancelModel={(model) => cancelMutation.mutate(model)}
        onComplete={(profile) => {
          onVoiceChange({
            ...voice,
            tts: {
              engine: "qwen",
              voiceKind: "profile",
              presetEngine: tts.presetEngine,
              presetVoiceId: tts.presetVoiceId,
              profileId: profile.id,
              playbackSpeed: tts.playbackSpeed,
            },
          });
          invalidateVoiceData();
          setCreateOpen(false);
        }}
      />
    </div>
  );
}
