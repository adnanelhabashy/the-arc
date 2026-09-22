// Shared presentational pieces: provenance badges, section cards, status dots.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Provenance } from "../server";

const PROVENANCE_STYLES: Record<Provenance, { dot: string; label: string }> = {
  "bb-observed": { dot: "bg-sky-400", label: "BB-observed" },
  "agent-reported": { dot: "bg-amber-400", label: "Agent-reported" },
  "user-confirmed": { dot: "bg-emerald-400", label: "User-confirmed" },
};

export function ProvenanceBadge({ provenance, className }: { provenance: Provenance; className?: string }) {
  const style = PROVENANCE_STYLES[provenance];
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] uppercase tracking-wide text-muted-foreground", className)}
      title={`Source: ${style.label}`}
    >
      <span className={cn("size-1.5 rounded-full", style.dot)} />
      {style.label}
    </span>
  );
}

export function SectionCard({
  title,
  provenance,
  actions,
  children,
  className,
}: {
  title: string;
  provenance?: Provenance;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-card", className)}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        <div className="flex items-center gap-2">
          {actions}
          {provenance !== undefined ? <ProvenanceBadge provenance={provenance} /> : null}
        </div>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export type ThreadStatus = "active" | "idle" | "pending" | "error" | "unknown";

const STATUS_STYLES: Record<ThreadStatus, { dot: string; pulse: boolean }> = {
  active: { dot: "bg-emerald-400", pulse: true },
  idle: { dot: "bg-muted-foreground/50", pulse: false },
  pending: { dot: "bg-amber-400", pulse: true },
  error: { dot: "bg-red-400", pulse: false },
  unknown: { dot: "bg-muted-foreground/30", pulse: false },
};

export function StatusDot({ status, className }: { status: ThreadStatus; className?: string }) {
  const style = STATUS_STYLES[status];
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} title={status}>
      {style.pulse ? <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-40", style.dot)} /> : null}
      <span className={cn("relative inline-flex size-2 rounded-full", style.dot)} />
    </span>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[11px] leading-4 text-foreground/90",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-4 text-center">
      <p className="text-sm text-muted-foreground">{title}</p>
      {children ? <div className="mt-2 text-xs text-muted-foreground/80">{children}</div> : null}
    </div>
  );
}

/** The refresh affordance both usage surfaces show, spinning while a fetch runs. */
export function RefreshIcon({ spinning = false, className }: { spinning?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("shrink-0", className, spinning && "animate-spin")}
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const deltaSeconds = Math.round((timestamp - now) / 1000);
  const abs = Math.abs(deltaSeconds);
  if (abs < 60) return RELATIVE_FORMATTER.format(deltaSeconds, "second");
  if (abs < 3600) return RELATIVE_FORMATTER.format(Math.round(deltaSeconds / 60), "minute");
  if (abs < 86400) return RELATIVE_FORMATTER.format(Math.round(deltaSeconds / 3600), "hour");
  return RELATIVE_FORMATTER.format(Math.round(deltaSeconds / 86400), "day");
}

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
