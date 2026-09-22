import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "@/lib/api";
import { toRelativeUrl } from "@/lib/api-server";
import { appSurfaceRequestInit } from "@/lib/app-surface";
import {
  invalidateArcAccounts,
  invalidateArcAgents,
  invalidateArcOmpProviders,
  invalidateArcUsage,
} from "../cache-owners/arc-cache-owner";
import {
  arcAccountsQueryKey,
  arcAgentsQueryKey,
  arcCurrentAgentUsageQueryKey,
  arcOmpProvidersQueryKey,
  arcStatusQueryKey,
} from "./query-keys";
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

export interface ArcActiveUsageAccount {
  accountKey: string | null;
  accountSourceId: string | null;
  providerLabel: string;
  providerFamily: string | null;
  planLabel: string | null;
  accountEmail: string | null;
  resolvedBy: "binding" | "provider";
}

export interface ArcCurrentAgentUsage {
  agentId: ArcAgentId;
  thread: ArcUsageResource | null;
  resources: ArcUsageResource[];
  activeAccount: ArcActiveUsageAccount | null;
  activeAccountUnknown: boolean;
}

export type ArcAccountSourceKind = "pool" | "omp";
export type ArcAccountAuthState =
  | "connected"
  | "expired"
  | "disabled"
  | "error"
  | "unknown";

export interface ArcAccount {
  id: string;
  sourceId: string;
  sourceKind: ArcAccountSourceKind;
  providerFamily: string;
  providerLabel: string;
  accountKey: string | null;
  email: string | null;
  planLabel: string | null;
  authState: ArcAccountAuthState;
  enabled: boolean;
  availableThrough: ArcAgentId[];
  observedAt: number;
}

export interface ArcAccountSourceStatus {
  kind: ArcAccountSourceKind;
  state: "ready" | "unavailable";
  detail: string | null;
  checkedAt: number;
}

export interface ArcAccountsList {
  accounts: ArcAccount[];
  sources: ArcAccountSourceStatus[];
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

export function useArcAccountsList({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: arcAccountsQueryKey(),
    queryFn: () => arcRpcCall<ArcAccountsList>("arc.accounts.list", null),
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useArcStatus() {
  return useQuery({
    queryKey: arcStatusQueryKey(),
    queryFn: () => arcRpcCall<ArcStatus>("arc.status", null),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useArcCurrentAgentUsage({
  agentId,
  accountKey,
  modelId,
  enabled,
}: {
  agentId: ArcAgentId | null;
  // The thread's bound account. Omitted (undefined) means "not known" —
  // the server reports activeAccountUnknown: true rather than guessing.
  accountKey?: string | null;
  // The thread's selected model id. For OMP this names the provider the next
  // turn runs on, which is how an unpinned OMP thread gets a real account
  // instead of "unknown". Part of the query key: switching the model must not
  // let the previous model's account state stand in for the new one.
  modelId?: string | null;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: arcCurrentAgentUsageQueryKey(
      agentId,
      accountKey ?? null,
      modelId ?? null,
    ),
    queryFn: () =>
      arcRpcCall<ArcCurrentAgentUsage>("arc.usage.current", {
        agentId: requireEnabledQueryArg({
          value: agentId,
          hookName: "useArcCurrentAgentUsage",
          argName: "agentId",
        }),
        ...(typeof accountKey === "string" ? { activeAccountKey: accountKey } : {}),
        ...(typeof modelId === "string" ? { activeModelId: modelId } : {}),
      }),
    enabled: enabled && agentId !== null,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

// The user's explicit refresh. It forces a real provider attempt for exactly
// the resources the caller is showing: a Refresh on a Codex thread must not
// spend a Claude or OMP vendor request. An empty list (nothing listed yet)
// refreshes everything, which is the only case where "what is shown" is
// unknown.
export function useArcUsageRefresh() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (resourceIds: readonly string[]) => {
      const targets = resourceIds.length === 0 ? [undefined] : resourceIds;
      for (const resourceId of targets) {
        await arcRpcCall<ArcUsageSnapshot>(
          "arc.usage.refresh",
          resourceId === undefined ? {} : { resourceId },
        );
      }
    },
    onSuccess: () => {
      void invalidateArcUsage(queryClient);
    },
  });
}

// Agent runtime readiness (Codex / Claude Code / OMP) — installed/installing/
// broken state, distinct from account (login) readiness. Used by onboarding.
export type ArcRuntimeState =
  | "not-prepared"
  | "preparing"
  | "ready"
  | "ready-with-warning"
  | "broken"
  | "unsupported"
  | "unavailable";

export type ArcAgentProviderState = "unknown" | "ready" | "unavailable" | "error";

export type ArcAgentAccountState =
  | "unknown"
  | "not-connected"
  | "connected"
  | "expired"
  | "error";

export type ArcAgentOverallState =
  | "not-prepared"
  | "preparing"
  | "runtime-ready"
  | "account-required"
  | "ready"
  | "broken"
  | "unsupported"
  | "unavailable";

export type ArcRuntimeCompatibility = "supported" | "untested" | "blocked";

export type ArcRuntimeSource =
  | "arc-bundled"
  | "arc-managed-download"
  | "official-managed-install"
  | "external-override";

export interface ArcAgentAction {
  id:
    | "prepare"
    | "repair"
    | "open-settings"
    | "connect-account"
    | "update"
    | "rollback";
  available: boolean;
  reason?: string;
}

export interface ArcAgentRuntimeStatus {
  state: ArcRuntimeState;
  version: string | null;
  compatibility: ArcRuntimeCompatibility | null;
  compatibilityReason: string | null;
  source: ArcRuntimeSource | null;
  knownGoodVersion: string | null;
}

export interface ArcAgentStatus {
  id: ArcAgentId;
  displayName: string;
  runtimeId: ArcAgentId;
  providerId: string;
  runtime: ArcAgentRuntimeStatus;
  provider: { state: ArcAgentProviderState };
  account: { state: ArcAgentAccountState };
  overallState: ArcAgentOverallState;
  actions: ArcAgentAction[];
  observedAt: number;
}

export function useArcAgentsList() {
  return useQuery({
    queryKey: arcAgentsQueryKey(),
    queryFn: () =>
      arcRpcCall<{ agents: ArcAgentStatus[] }>("arc.agents.list", null),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useArcAgentPrepare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: ArcAgentId) =>
      arcRpcCall<{ agent: ArcAgentStatus }>("arc.agents.prepare", { id }),
    onSuccess: () => {
      void invalidateArcAgents(queryClient);
    },
  });
}

export function useArcAgentRepair() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: ArcAgentId) =>
      arcRpcCall<{ agent: ArcAgentStatus }>("arc.agents.repair", { id }),
    onSuccess: () => {
      void invalidateArcAgents(queryClient);
    },
  });
}

// Account login flows (ChatGPT device code, Claude manual auth code, OMP
// browser/device/api-key). Secrets never round-trip through React state
// beyond the single submit call.
export interface ArcOpenAiLoginChallenge {
  provider: "openai";
  sessionId: string;
  verificationUri: string;
  userCode: string;
  expiresAt: number;
  intervalMs: number;
}

export interface ArcClaudeLoginChallenge {
  provider: "anthropic";
  sessionId: string;
  authorizeUrl: string;
  expiresAt: number | null;
}

export type ArcLoginPollState = "waiting-for-user" | "connected" | "failed";

export type ArcAccountLoginState =
  | "idle"
  | "starting"
  | "waiting-for-user"
  | "authorizing"
  | "connected"
  | "failed"
  | "expired"
  | "cancelled";

export interface ArcOpenAiLoginPoll {
  state: ArcLoginPollState;
  account: ArcAccount | null;
  message: string | null;
}

export interface ArcOpenAiLoginPollResult {
  poll: ArcOpenAiLoginPoll;
  state: ArcAccountLoginState;
}

export interface ArcOmpProvider {
  id: string;
  displayName: string;
  authMethod: "oauth" | "api-key" | "unknown";
  connectionState: "connected" | "not-connected" | "unknown";
  hasAccounts: boolean;
}

export interface ArcOmpLoginChallenge {
  provider: string;
  sessionId: string;
  kind: "oauth" | "api-key";
  flow: "browser" | "device";
  userCode: string | null;
  authorizeUrl: string | null;
  instructions: string | null;
  expiresAt: number | null;
}

export interface ArcOmpLoginPoll {
  state: ArcLoginPollState;
  account: ArcAccount | null;
  message: string | null;
}

export function useArcOmpProvidersList() {
  return useQuery({
    queryKey: arcOmpProvidersQueryKey(),
    queryFn: () =>
      arcRpcCall<{ providers: ArcOmpProvider[] }>("arc.omp.providers", null),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useArcLogin() {
  const queryClient = useQueryClient();
  const onAccountChanged = () => {
    void invalidateArcAccounts(queryClient);
    void invalidateArcUsage(queryClient);
  };

  return {
    openaiStart: async () => {
      const result = await arcRpcCall<{ challenge: ArcOpenAiLoginChallenge }>(
        "arc.login.openai.start",
        null,
      );
      return result.challenge;
    },
    openaiPoll: async (sessionId: string) => {
      const result = await arcRpcCall<ArcOpenAiLoginPollResult>(
        "arc.login.openai.poll",
        { sessionId },
      );
      if (result.poll.state === "connected") onAccountChanged();
      return result;
    },
    openaiCancel: async (sessionId: string) => {
      await arcRpcCall<{ ok: true }>("arc.login.openai.cancel", {
        sessionId,
      });
    },
    claudeStart: async () => {
      const result = await arcRpcCall<{ challenge: ArcClaudeLoginChallenge }>(
        "arc.login.claude.start",
        null,
      );
      return result.challenge;
    },
    claudeComplete: async (sessionId: string, code: string) => {
      const result = await arcRpcCall<{ account: ArcAccount }>(
        "arc.login.claude.complete",
        { sessionId, code },
      );
      onAccountChanged();
      return result.account;
    },
    ompStart: async (provider: string) => {
      const result = await arcRpcCall<{ challenge: ArcOmpLoginChallenge }>(
        "arc.omp.login.start",
        { provider },
      );
      return result.challenge;
    },
    ompPoll: async (sessionId: string) => {
      const result = await arcRpcCall<{ poll: ArcOmpLoginPoll }>(
        "arc.omp.login.poll",
        { sessionId },
      );
      if (result.poll.state === "connected") {
        onAccountChanged();
        void invalidateArcOmpProviders(queryClient);
      }
      return result.poll;
    },
    ompCancel: async (sessionId: string) => {
      await arcRpcCall<{ ok: true }>("arc.omp.login.cancel", { sessionId });
    },
    ompSubmitKey: async (sessionId: string, key: string) => {
      await arcRpcCall<{ ok: true }>("arc.omp.login.submitKey", {
        sessionId,
        key,
      });
      onAccountChanged();
      void invalidateArcOmpProviders(queryClient);
    },
  };
}
