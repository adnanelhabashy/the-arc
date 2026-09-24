import { useMemo } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import type {
  SystemVoiceCapabilitiesResponse,
  SystemVoiceEngineCapabilities,
} from "@bb/server-contract";
import { SettingsSection } from "@/components/ui/settings-section";
import {
  isKnownTtsEngine,
  isPresetSelected,
  type VoiceTtsSettings,
} from "./voice-selection";
import { voiceLanguageLabel } from "./voice-language";
import {
  engineHasDownloadedModel,
  resolveEngineDownloadModel,
} from "./voice-models";
import { VoiceModelDownloadControl } from "./VoiceModelDownloadControl";
import {
  VOICE_PREVIEW_PHRASE,
  type VoicePreviewApi,
} from "./use-voice-preview";

interface GalleryCard {
  engine: string;
  voiceId: string;
  name: string;
  gender: string;
  language: string;
}

interface VoiceGalleryProps {
  capabilities: SystemVoiceCapabilitiesResponse;
  tts: VoiceTtsSettings;
  preview: VoicePreviewApi;
  playbackSpeed: number;
  onSelectPreset: (engine: string, voiceId: string) => void;
  onDownloadModel: (modelName: string) => void;
  onCancelModel: (modelName: string) => void;
}

function presetCharacterLine(card: GalleryCard): string {
  const label = voiceLanguageLabel(card.language);
  return card.gender.length > 0
    ? `A ${card.gender} voice for ${label}.`
    : `A voice for ${label}.`;
}

function buildRecommended(cards: readonly GalleryCard[]): GalleryCard[] {
  const kokoroEnglish = cards
    .filter((card) => card.engine === "kokoro" && card.language === "en")
    .slice(0, 6);
  const qwenCustom = cards.filter(
    (card) => card.engine === "qwen_custom_voice",
  );
  return [...kokoroEnglish, ...qwenCustom];
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

function VoiceCard({
  card,
  selected,
  previewing,
  onSelect,
  onPreview,
}: {
  card: GalleryCard;
  selected: boolean;
  previewing: boolean;
  onSelect: () => void;
  onPreview: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        selected ? "border-foreground/40 bg-surface" : "border-border bg-surface-recessed",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-start justify-between gap-2 text-left"
        aria-pressed={selected}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {card.name}
          </span>
          <span className="mt-0.5 block text-xs leading-snug text-subtle-foreground">
            {presetCharacterLine(card)}
          </span>
        </span>
        <Icon
          name="Check"
          className={cn("size-4 shrink-0 text-foreground", !selected && "opacity-0")}
        />
      </button>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground">
          {voiceLanguageLabel(card.language)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onPreview}
          aria-label={previewing ? "Stop preview" : "Preview voice"}
        >
          <Icon name={previewing ? "Square" : "Play"} className="size-3.5" />
          {previewing ? "Stop" : "Preview"}
        </Button>
      </div>
    </div>
  );
}

function EngineDownloadGate({
  engineCaps,
  onDownload,
  onCancel,
}: {
  engineCaps: SystemVoiceEngineCapabilities;
  onDownload: (modelName: string) => void;
  onCancel: (modelName: string) => void;
}) {
  const model = resolveEngineDownloadModel(engineCaps);
  if (model === null) {
    return null;
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-recessed px-3 py-2">
      <span className="text-xs text-subtle-foreground">
        {model.displayName} is required to preview these voices.
      </span>
      <VoiceModelDownloadControl
        modelName={model.name}
        downloading={model.downloading}
        downloadPercent={model.downloadPercent}
        onDownload={() => onDownload(model.name)}
        onCancel={() => onCancel(model.name)}
      />
    </div>
  );
}

export function VoiceGallery({
  capabilities,
  tts,
  preview,
  playbackSpeed,
  onSelectPreset,
  onDownloadModel,
  onCancelModel,
}: VoiceGalleryProps) {
  const enginesWithPresets = useMemo(
    () =>
      capabilities.engines.filter(
        (engine) =>
          isKnownTtsEngine(engine.engine) &&
          engine.presets !== null &&
          engine.presets.length > 0,
      ),
    [capabilities.engines],
  );
  const cards = useMemo<GalleryCard[]>(
    () =>
      enginesWithPresets.flatMap((engine) =>
        (engine.presets ?? []).map((preset) => ({
          engine: engine.engine,
          voiceId: preset.voiceId,
          name: preset.name,
          gender: preset.gender,
          language: preset.language,
        })),
      ),
    [enginesWithPresets],
  );
  const recommended = useMemo(() => buildRecommended(cards), [cards]);

  const renderCard = (card: GalleryCard) => {
    const key = `preset:${card.engine}:${card.voiceId}`;
    const previewing = preview.activeKey === key && preview.phase !== "idle";
    return (
      <VoiceCard
        key={key}
        card={card}
        selected={isPresetSelected(tts, card.engine, card.voiceId)}
        previewing={previewing}
        onSelect={() => onSelectPreset(card.engine, card.voiceId)}
        onPreview={() => {
          if (previewing) {
            preview.stop();
            return;
          }
          preview.start(
            {
              key,
              text: VOICE_PREVIEW_PHRASE,
              engine: card.engine,
              presetVoiceId: card.voiceId,
            },
            playbackSpeed,
          );
        }}
      />
    );
  };

  return (
    <SettingsSection
      title="Voice Gallery"
      description="Preview and choose the preset voice Arc uses to read replies."
    >
      <div className="space-y-4">
        {enginesWithPresets.map((engine) =>
          engineHasDownloadedModel(engine) ? null : (
            <EngineDownloadGate
              key={engine.engine}
              engineCaps={engine}
              onDownload={onDownloadModel}
              onCancel={onCancelModel}
            />
          ),
        )}
        {recommended.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle-foreground">
              Recommended
            </h3>
            <CardGrid>{recommended.map(renderCard)}</CardGrid>
          </div>
        ) : null}
        {enginesWithPresets.map((engine) => (
          <div key={engine.engine} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle-foreground">
              {engine.engine}
            </h3>
            <CardGrid>
              {cards
                .filter((card) => card.engine === engine.engine)
                .map(renderCard)}
            </CardGrid>
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
