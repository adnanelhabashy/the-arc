import { useId, useState, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import type { ThreadContextWindowUsage } from "@bb/server-contract";
import { useHoverPopover } from "../../ui/hooks/use-hover-popover.js";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  calculateContextWindowUsagePercent,
  formatCompactTokenCount,
} from "./thread-context-window-usage.js";
import { ProviderUsageSection } from "./ProviderUsageSection.js";

import {
  ContextWindowReveal,
  ThreadContextWindowDetails,
  ThreadContextWindowSegments,
} from "./ThreadContextWindowDetails.js";

interface ThreadContextWindowCardProps {
  usage: ThreadContextWindowUsage;
  className?: string;
  title?: string;
  usageLimits?: ReactNode;
}

interface ThreadContextWindowIndicatorProps {
  usage: ThreadContextWindowUsage;
  defaultOpen?: boolean;
  providerId?: string;
  modelLabel?: string;
  // The thread's selected model id, when the caller knows it. OMP namespaces
  // its model ids by provider, which is how the usage popup resolves an
  // unpinned OMP thread's active account.
  modelId?: string;
  // The thread's bound account, when the caller knows it. Undefined
  // renders "Active account unknown" rather than guessing.
  accountKey?: string | null;
}

export function ThreadContextWindowCard({
  usage,
  className,
  title,
  usageLimits,
}: ThreadContextWindowCardProps) {
  const details = usage.snapshot?.categories.length
    ? usage.snapshot
    : undefined;
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const detailsId = useId();
  const usedPercent = calculateContextWindowUsagePercent(usage);
  const leftPercent = Math.max(0, 100 - usedPercent);
  const visualPercent = Math.min(Math.max(usedPercent, 0), 100);

  const toneClass =
    usedPercent >= 90
      ? "text-destructive"
      : usedPercent >= 75
        ? "text-warning-text"
        : "text-muted-foreground";

  const usedTokensLabel = formatCompactTokenCount(usage.usedTokens);
  const windowTokensLabel = formatCompactTokenCount(usage.modelContextWindow);
  const titleLabel = usage.estimated ? "Estimated context" : "Context window";

  return (
    <div
      className={cn(
        "@container/context-window w-72 rounded-md border bg-popover p-2 text-popover-foreground shadow-md max-md:px-4",
        details &&
          "transition-[width] duration-200 ease-out motion-reduce:transition-none",
        details && detailsExpanded && "w-90",
        className,
      )}
    >
      <div className="flex flex-col gap-2 max-md:gap-3">
        {title ? (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">
              {title}
            </span>
          </div>
        ) : null}
        <div className="flex items-baseline justify-between gap-2 text-xs max-md:text-sm">
          <span
            className={cn(
              "text-muted-foreground",
              details && detailsExpanded && "font-medium text-foreground",
            )}
          >
            {titleLabel}
          </span>
          <span className={cn("font-medium tabular-nums", toneClass)}>
            {usedPercent}% used
          </span>
        </div>
        <div
          className={cn(
            "relative h-1.5 w-full overflow-hidden rounded-full bg-border transition-[height] duration-200 motion-reduce:transition-none max-md:h-2",
            details && detailsExpanded && "order-2 h-4 max-md:h-5",
          )}
        >
          <div
            className={cn(
              "h-full rounded-full bg-current transition-opacity duration-200 ease-out motion-reduce:transition-none",
              toneClass,
              details && detailsExpanded && "opacity-0",
            )}
            style={{ width: `${visualPercent}%` }}
          />
          {details ? (
            <ThreadContextWindowSegments
              details={details}
              modelContextWindow={usage.modelContextWindow}
              visible={detailsExpanded}
            />
          ) : null}
        </div>
        <div
          className={cn(
            "flex items-baseline justify-between gap-2 text-xs tabular-nums text-muted-foreground max-md:text-sm",
            details && detailsExpanded && "order-1",
          )}
        >
          <span>
            <span
              className={cn(
                details && detailsExpanded && "font-medium text-foreground",
              )}
            >
              {usedTokensLabel}
            </span>{" "}
            / {windowTokensLabel} tokens
          </span>
          <span>{leftPercent}% left</span>
        </div>
      </div>
      {details ? (
        <>
          <div className="-mx-2 max-md:-mx-4">
            <ContextWindowReveal id={detailsId} open={detailsExpanded}>
              <ThreadContextWindowDetails
                details={details}
                capacity={usage.modelContextWindow}
              />
            </ContextWindowReveal>
          </div>
          <button
            type="button"
            className="ml-auto mt-2 flex cursor-pointer items-center gap-1.5 rounded-xs text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:mt-3 max-md:py-1 max-md:text-sm"
            aria-expanded={detailsExpanded}
            aria-controls={detailsId}
            onClick={() => setDetailsExpanded((value) => !value)}
          >
            {detailsExpanded ? "Hide details" : "Show details"}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              aria-hidden="true"
              data-icon-root=""
              className={cn(
                "size-3 transition-transform duration-200 ease-out motion-reduce:transition-none",
                detailsExpanded && "rotate-180",
              )}
            >
              <path d="m4 6 4 4 4-4" />
            </svg>
          </button>
        </>
      ) : null}
      {usageLimits ? (
        <>
          <div className="-mx-2 mt-2 border-t border-border-hairline max-md:-mx-4" />
          {usageLimits}
        </>
      ) : null}
    </div>
  );
}

export function ThreadContextWindowIndicator({
  usage,
  defaultOpen,
  providerId,
  modelLabel,
  modelId,
  accountKey,
}: ThreadContextWindowIndicatorProps) {
  const {
    open: hoverOpen,
    triggerHoverProps,
    contentHoverProps,
    handleOpenChange,
  } = useHoverPopover({
    closeDelayMs: 200,
    hoverableContent: true,
  });
  const open = defaultOpen || hoverOpen;

  const usedPercent = calculateContextWindowUsagePercent(usage);
  const visualPercent = Math.min(Math.max(usedPercent, 0), 100);

  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - visualPercent / 100);

  const toneClass =
    usedPercent >= 90
      ? "text-destructive"
      : usedPercent >= 75
        ? "text-warning-text"
        : "text-muted-foreground";

  const titleLabel = usage.estimated ? "Estimated context" : "Context window";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          {...triggerHoverProps}
          className="-m-1 inline-flex size-8 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Context window ${usedPercent}% used`}
        >
          <svg
            viewBox="0 0 16 16"
            className={cn("size-4", toneClass)}
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              strokeWidth="3"
              className="stroke-border-hairline"
            />
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 8 8)"
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        {...contentHoverProps}
        mobileTitle={titleLabel}
        className="w-auto border-0 bg-transparent p-0 shadow-none max-md:p-0"
      >
        <ThreadContextWindowCard
          usage={usage}
          title="Usage & Limits"
          usageLimits={
            providerId !== undefined ? (
              <ProviderUsageSection
                active={open}
                providerId={providerId}
                modelLabel={modelLabel}
                modelId={modelId}
                accountKey={accountKey}
              />
            ) : undefined
          }
          className="max-md:w-full max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:px-4 max-md:pt-2 max-md:pb-[max(1rem,env(safe-area-inset-bottom))] max-md:shadow-none"
        />
      </PopoverContent>
    </Popover>
  );
}
