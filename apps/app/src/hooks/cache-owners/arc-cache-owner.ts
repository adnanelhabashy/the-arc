import type { QueryClient } from "@tanstack/react-query";
import {
  allArcCurrentAgentUsageQueryKeyPrefix,
  arcAccountsQueryKey,
  arcStatusQueryKey,
} from "../queries/query-keys";

// Arc's own cache boundary in the app. Arc Core publishes `arc-changed` after
// every mutation it performs, so the app invalidates from that signal instead
// of waiting out a staleTime — and never by polling. Invalidation is by
// domain: a change to which accounts exist also invalidates usage, because
// usage resources hang off account identity.

export function invalidateArcAccounts(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: arcAccountsQueryKey() });
}

export function invalidateArcStatus(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: arcStatusQueryKey() });
}

export function invalidateArcUsage(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: allArcCurrentAgentUsageQueryKeyPrefix(),
  });
}

// The channel arc-core publishes on (plugins/arc-core/src/realtime.ts). The
// app cannot import plugin code, so the wire name is mirrored here.
export const ARC_CHANGED_CHANNEL = "arc-changed";

export type ArcChangedKind = "agents" | "accounts" | "omp" | "usage";

export function readArcChangedKind(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const kind = (payload as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

// Mirrors plugins/arc-core/src/realtime.ts's ArcChangedKind. An unknown kind
// (a newer arc-core, or a malformed payload) invalidates nothing rather than
// guessing.
export function invalidateArcChangedKind(
  queryClient: QueryClient,
  kind: string,
): void {
  switch (kind) {
    case "accounts":
    case "omp":
      void invalidateArcAccounts(queryClient);
      void invalidateArcUsage(queryClient);
      return;
    case "usage":
      void invalidateArcUsage(queryClient);
      return;
    case "agents":
      // The app has no Arc runtime/agent-status surface; runtime status is
      // Mission Control's, which subscribes to the same signal itself.
      return;
    default:
      return;
  }
}
