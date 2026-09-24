import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { ProgressBar } from "./ProgressBar";

export function VoiceModelDownloadControl({
  modelName,
  downloading,
  downloadPercent,
  onDownload,
  onCancel,
}: {
  modelName: string;
  downloading: boolean;
  downloadPercent: number | null;
  onDownload: () => void;
  onCancel: () => void;
}) {
  if (downloading) {
    return (
      <div className="flex items-center gap-2">
        <ProgressBar
          value={downloadPercent ?? 0}
          className="w-24"
          aria-label={`${modelName} download progress`}
        />
        <span className="text-xs tabular-nums text-subtle-foreground">
          {downloadPercent !== null ? `${Math.round(downloadPercent)}%` : "…"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          aria-label={`Cancel ${modelName} download`}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onDownload}
      aria-label={`Download ${modelName}`}
    >
      <Icon name="Download" className="size-3.5" />
      Download
    </Button>
  );
}
