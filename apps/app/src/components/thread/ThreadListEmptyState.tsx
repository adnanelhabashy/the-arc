import { EmptyState } from "@bb/shared-ui/empty-state";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

export const NO_THREADS_MESSAGE = "No threads";

export function ThreadListEmptyState({
  message = NO_THREADS_MESSAGE,
  hint,
  showIcon = true,
  className,
}: {
  message?: string;
  hint?: string;
  showIcon?: boolean;
  className?: string;
}) {
  if (hint === undefined) {
    return (
      <EmptyState
        message={message}
        icon={showIcon ? "MessageSquare" : undefined}
        className={className}
        iconClassName="size-3.5 text-subtle-foreground/50"
        messageClassName="text-xs leading-4 text-subtle-foreground/60"
      />
    );
  }

  return (
    <div className={cn("flex min-w-0 items-start gap-2", className)}>
      {showIcon ? (
        <Icon
          name="MessageSquare"
          aria-hidden="true"
          className="mt-px size-3.5 shrink-0 text-subtle-foreground/50"
        />
      ) : null}
      <div className="min-w-0">
        <p className="text-xs leading-4 text-muted-foreground">{message}</p>
        <p className="mt-0.5 text-xs leading-4 text-subtle-foreground/75">
          {hint}
        </p>
      </div>
    </div>
  );
}
