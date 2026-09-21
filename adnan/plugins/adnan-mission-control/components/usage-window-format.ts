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

export function percentTone(usedPercent: number): string {
  const remaining = 100 - usedPercent;
  if (remaining < 20) return "bg-red-400";
  if (remaining <= 50) return "bg-amber-400";
  return "bg-emerald-400/80";
}

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
