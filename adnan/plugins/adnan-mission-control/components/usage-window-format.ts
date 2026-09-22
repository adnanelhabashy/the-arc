// The Arc usage render rules, in one place. Mission Control's Usage & Limits
// page and the sidebar's Accounts & Usage disclosure both read the same
// snapshot, so the rule that decides what a window is allowed to say must not
// exist twice: a percentage only when the provider reported a real fraction,
// the provider's own amount otherwise, and never a fabricated zero for a
// resource that reported nothing (UNKNOWN != ZERO).
import type {
  ArcUsageResource,
  ArcUsageUnit,
  ArcUsageWindow,
} from "@/lib/arc-types";

export const UNIT_LABEL: Record<ArcUsageUnit, string> = {
  percent: "%",
  tokens: "tokens",
  requests: "requests",
  credits: "credits",
  usd: "",
  minutes: "min",
  bytes: "bytes",
  unknown: "",
};

export function clampPercent(value: number): number {
  return Math.min(Math.max(value, 0), 100);
}

/** Where a window sits between healthy and spent, for tone only. */
export type QuotaState = "ok" | "low" | "exhausted" | "unknown";

/**
 * The provider's own status when it reported one, otherwise the bar's own
 * number. A window with nothing measurable stays `unknown` and is never
 * painted as though it had been measured — the same rule that keeps a missing
 * measurement out of the percentage (UNKNOWN != ZERO).
 */
export function quotaState(window: ArcUsageWindow): QuotaState {
  if (window.status === "exhausted") return "exhausted";
  if (window.status === "warning") return "low";
  if (window.remainingAmount !== null && window.remainingAmount <= 0) {
    return "exhausted";
  }
  if (window.remainingPercent !== null && window.remainingPercent <= 0) {
    return "exhausted";
  }
  const used = windowBarPercent(window);
  if (used === null) return "unknown";
  if (used >= 100) return "exhausted";
  if (used >= 80) return "low";
  return "ok";
}

/**
 * Risk tone per state: healthy quota stays quiet ink so that colour only ever
 * means something, low quota takes the warning tier and an exhausted window
 * the destructive one. Both tiers are theme tokens, so they hold their
 * contrast in light mode too.
 */
export const QUOTA_TONE: Record<QuotaState, { bar: string; value: string }> = {
  ok: { bar: "bg-foreground/45", value: "text-foreground" },
  low: { bar: "bg-warning", value: "text-warning-text" },
  exhausted: { bar: "bg-destructive", value: "text-destructive-text" },
  unknown: { bar: "bg-foreground/45", value: "text-muted-foreground" },
};

/** Compact countdown like "2h 14m"; dates beyond 48h render as "Sep 24". */
export function resetText(resetsAt: number, now: number): string {
  const delta = resetsAt - now;
  if (delta <= 48 * 60 * 60 * 1_000) {
    const totalMinutes = Math.max(1, Math.round(delta / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours === 0
      ? `Resets in ${minutes}m`
      : `Resets in ${hours}h ${minutes}m`;
  }
  return `Resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(resetsAt)}`;
}

export function formatRemainingAmount(
  amount: number,
  unit: ArcUsageUnit | null,
): string {
  if (unit === "usd") return `$${amount.toFixed(2)} remaining`;
  const label = unit === null || unit === "unknown" ? "" : UNIT_LABEL[unit];
  return label === "" ? `${amount} remaining` : `${amount} ${label} remaining`;
}

/** The bar width for a window, or null when a bar would fabricate a percent. */
export function windowBarPercent(window: ArcUsageWindow): number | null {
  if (window.usedPercent !== null) return clampPercent(window.usedPercent);
  if (window.remainingPercent !== null) {
    return clampPercent(100 - window.remainingPercent);
  }
  if (
    window.limitAmount !== null &&
    window.limitAmount > 0 &&
    window.usedAmount !== null
  ) {
    return clampPercent((window.usedAmount / window.limitAmount) * 100);
  }
  return null;
}

/**
 * What a window is allowed to say it has left: the provider's percentage when
 * it reported one, the provider's own remaining amount when it reported
 * amounts, and null when it reported neither — the caller renders that as
 * unavailable rather than as zero.
 */
export function windowValueText(window: ArcUsageWindow): string | null {
  if (window.remainingPercent !== null) {
    return `${Math.round(window.remainingPercent)}% remaining`;
  }
  if (window.usedPercent !== null) {
    return `${100 - Math.round(clampPercent(window.usedPercent))}% remaining`;
  }
  if (
    window.limitAmount !== null &&
    window.limitAmount > 0 &&
    window.usedAmount !== null
  ) {
    const remaining =
      window.remainingAmount !== null
        ? window.remainingAmount
        : Math.max(0, window.limitAmount - window.usedAmount);
    return formatRemainingAmount(remaining, window.unit);
  }
  if (window.remainingAmount !== null) {
    return formatRemainingAmount(window.remainingAmount, window.unit);
  }
  return null;
}

export const EXHAUSTED_LABEL = "Exhausted";

/**
 * What a window says it has left. A provider that reported exhaustion without
 * an amount still has something to say, so the state fills in where the
 * number is missing rather than rendering "n/a".
 */
export function windowValueLabel(window: ArcUsageWindow): string {
  const value = windowValueText(window);
  if (value !== null) return value;
  return quotaState(window) === "exhausted" ? EXHAUSTED_LABEL : "n/a";
}

/** The same window, spelled the same way by every provider that reports it. */
const WINDOW_LABEL_ALIASES: Record<string, string> = {
  "5 hour limit": "5h",
  "5-hour limit": "5h",
  "5h limit": "5h",
  "five-hour limit": "5h",
  "weekly limit": "Weekly",
  "monthly limit": "Monthly",
};

/** Providers name the same window differently; anything unlisted is theirs. */
export function windowDisplayLabel(window: ArcUsageWindow): string {
  return WINDOW_LABEL_ALIASES[window.label.trim().toLowerCase()] ?? window.label;
}

/**
 * The account's own name, which is what the user picked between: its provider
 * plus its plan. An OMP provider account has no plan of its own and already
 * carries the provider as its plan label, so neither is ever printed twice.
 */
export function accountTitle(resource: ArcUsageResource): string {
  const plan =
    resource.planLabel === null ? "" : resource.planLabel.trim();
  const titled = plan.charAt(0).toUpperCase() + plan.slice(1);
  if (titled === "" || titled === resource.providerLabel) {
    return resource.providerLabel;
  }
  return `${resource.providerLabel} ${titled}`;
}

/** Why a resource carries no measurement, in the user's terms. */
export function resourceStatusText(resource: ArcUsageResource): string {
  if (resource.status === "error") {
    return resource.message ?? "Usage temporarily unavailable";
  }
  if (resource.status === "unavailable") {
    const label =
      resource.unavailableReason === "not-exposed"
        ? "Usage limits not exposed by provider"
        : resource.unavailableReason === "disabled"
          ? "Connected · temporarily unavailable"
          : resource.unavailableReason === "not-connected"
            ? "Connect an account to see usage"
            : "Usage temporarily unavailable";
    return resource.message !== null &&
      resource.unavailableReason === "not-exposed"
      ? `${label} — ${resource.message}`
      : label;
  }
  if (resource.status === "unknown") return "Usage unavailable";
  return "";
}
