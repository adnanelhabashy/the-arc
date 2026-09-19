import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "@/lib/api";
import { toRelativeUrl } from "@/lib/api-server";
import { appSurfaceRequestInit } from "@/lib/app-surface";
import { requireEnabledQueryArg } from "./query-helpers";

// Typed client for the Arc Core plugin RPC surface. The wire schemas live in
// plugins/arc-core/src/contract.ts; these interfaces mirror the *output* types
// (plain JSON) so apps/app never imports plugin code.
export type ArcAgentId = "codex" | "claude-code" | "omp";

export type ArcUsageSourceKind = "pool" | "omp" | "thread";
export type ArcUsageResourceStatus =
  | "available"
  | "unavailable"
  | "error"
  | "unknown";
export type ArcUsageUnavailableReason =
  | "not-exposed"
  | "not-connected"
  | "disabled";
export type ArcUsageWindowKind =
  | "five-hour"
  | "daily"
  | "weekly"
  | "monthly"
  | "custom";
export type ArcUsageWindowStatus = "ok" | "warning" | "exhausted" | "unknown";
export type ArcUsageUnit =
  | "percent"
  | "tokens"
  | "requests"
  | "credits"
  | "usd"
  | "minutes"
  | "bytes"
  | "unknown";

export interface ArcUsageWindow {
  id: string;
  label: string;
  kind: ArcUsageWindowKind;
  status: ArcUsageWindowStatus | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  usedAmount: number | null;
  limitAmount: number | null;
  remainingAmount: number | null;
  unit: ArcUsageUnit | null;
  resetsAt: number | null;
  observedAt: number | null;
  source: ArcUsageSourceKind | null;
}

export interface ArcUsageResource {
  id: string;
  sourceKind: ArcUsageSourceKind;
  accountKey: string | null;
  accountSourceId: string | null;
  providerFamily: string | null;
  providerLabel: string;
  accountEmail: string | null;
  planLabel: string | null;
  modelLabel: string | null;
  agentIds: ArcAgentId[];
  windows: ArcUsageWindow[];
  observedAt: number | null;
  fetchedAt: number | null;
  stale: boolean;
  status: ArcUsageResourceStatus;
  unavailableReason: ArcUsageUnavailableReason | null;
  credentialDisabled: boolean;
  message: string | null;
  sources: ArcUsageSourceKind[];
}

export interface ArcUsageSourceStatus {
  kind: ArcUsageSourceKind;
  state: "ready" | "unavailable";
  detail: string | null;
  checkedAt: number;
}

export interface ArcUsageSnapshot {
  generatedAt: number;
  resources: ArcUsageResource[];
  sources: ArcUsageSourceStatus[];
}

export interface ArcCurrentAgentUsage {
  agentId: ArcAgentId;
  thread: ArcUsageResource | null;
  resources: ArcUsageResource[];
  activeAccountUnknown: boolean;
}

interface ArcRpcEnvelope<T> {
  ok: true;
  result: T;
}

export async function arcRpcCall<T>(
  method: string,
  input: unknown,
): Promise<T> {
  const url = new URL(
    `/api/v1/plugins/arc-core/rpc/${method}`,
    location.origin,
  );
  const envelope = await request<ArcRpcEnvelope<T>>(
    fetch(
      toRelativeUrl(url),
      appSurfaceRequestInit({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input ?? null),
      }),
    ),
  );
  return envelope.result;
}

export interface ArcStatus {
  arcAvailable: boolean;
  reason: string | null;
}

const ARC_STATUS_QUERY_KEY = "arcStatus" as const;
const ARC_CURRENT_AGENT_USAGE_QUERY_KEY = "arcCurrentAgentUsage" as const;

export function useArcStatus() {
  return useQuery({
    queryKey: [ARC_STATUS_QUERY_KEY],
    queryFn: () => arcRpcCall<ArcStatus>("arc.status", null),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useArcCurrentAgentUsage({
  agentId,
  enabled,
}: {
  agentId: ArcAgentId | null;
  enabled: boolean;
}) {
  return useQuery({
    queryKey:
      agentId === null
        ? [ARC_CURRENT_AGENT_USAGE_QUERY_KEY]
        : [ARC_CURRENT_AGENT_USAGE_QUERY_KEY, agentId],
    queryFn: () =>
      arcRpcCall<ArcCurrentAgentUsage>("arc.usage.current", {
        agentId: requireEnabledQueryArg({
          value: agentId,
          hookName: "useArcCurrentAgentUsage",
          argName: "agentId",
        }),
      }),
    enabled: enabled && agentId !== null,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useArcUsageRefresh() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => arcRpcCall<ArcUsageSnapshot>("arc.usage.refresh", {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [ARC_CURRENT_AGENT_USAGE_QUERY_KEY],
      });
    },
  });
}
