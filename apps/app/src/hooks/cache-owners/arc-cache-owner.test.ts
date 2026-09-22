import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  ARC_CHANGED_CHANNEL,
  invalidateArcAccounts,
  invalidateArcChangedKind,
  invalidateArcStatus,
  invalidateArcUsage,
  handleArcPluginSignal,
  readArcChangedKind,
} from "./arc-cache-owner";
import {
  allArcCurrentAgentUsageQueryKeyPrefix,
  arcAccountsQueryKey,
  arcAgentsQueryKey,
  arcCurrentAgentUsageQueryKey,
  arcOmpProvidersQueryKey,
  arcStatusQueryKey,
} from "../queries/query-keys";

// Phase 14: Arc's caches invalidate from arc-core's own change signal, and
// account-scoped reads are keyed by account identity so one account's cached
// reading can never be served for another.

function stateOf(queryClient: QueryClient, queryKey: readonly unknown[]) {
  return queryClient.getQueryState(queryKey)?.isInvalidated ?? null;
}

describe("arc cache invalidation", () => {
  it("invalidates only the requested domain", async () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(arcAccountsQueryKey(), { accounts: [] });
    queryClient.setQueryData(arcStatusQueryKey(), { arcAvailable: true });
    queryClient.setQueryData(
      arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:a", null),
      { resources: [] },
    );

    await invalidateArcAccounts(queryClient);

    expect(stateOf(queryClient, arcAccountsQueryKey())).toBe(true);
    expect(stateOf(queryClient, arcStatusQueryKey())).toBe(false);
    expect(
      stateOf(
        queryClient,
        arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:a", null),
      ),
    ).toBe(false);

    await invalidateArcStatus(queryClient);
    await invalidateArcUsage(queryClient);
    expect(stateOf(queryClient, arcStatusQueryKey())).toBe(true);
    expect(
      stateOf(
        queryClient,
        arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:a", null),
      ),
    ).toBe(true);
  });

  it("invalidates every account's usage when the account list changes", async () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(
      arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus", null),
      { resources: [] },
    );
    queryClient.setQueryData(
      arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:team", null),
      { resources: [] },
    );

    invalidateArcChangedKind(queryClient, "accounts");

    expect(
      stateOf(
        queryClient,
        arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus", null),
      ),
    ).toBe(true);
    expect(
      stateOf(
        queryClient,
        arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:team", null),
      ),
    ).toBe(true);
  });

  it("invalidates only the agents cache for an agents change", () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(arcAccountsQueryKey(), { accounts: [] });
    queryClient.setQueryData(arcAgentsQueryKey(), { agents: [] });
    queryClient.setQueryData(
      arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus", null),
      { resources: [] },
    );

    invalidateArcChangedKind(queryClient, "agents");

    expect(stateOf(queryClient, arcAgentsQueryKey())).toBe(true);
    expect(stateOf(queryClient, arcAccountsQueryKey())).toBe(false);
    expect(
      stateOf(
        queryClient,
        arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus", null),
      ),
    ).toBe(false);
  });

  it("invalidates accounts, OMP providers, and usage for an omp change", () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(arcAccountsQueryKey(), { accounts: [] });
    queryClient.setQueryData(arcOmpProvidersQueryKey(), { providers: [] });
    queryClient.setQueryData(
      arcCurrentAgentUsageQueryKey("omp", null, null),
      { resources: [] },
    );

    invalidateArcChangedKind(queryClient, "omp");

    expect(stateOf(queryClient, arcAccountsQueryKey())).toBe(true);
    expect(stateOf(queryClient, arcOmpProvidersQueryKey())).toBe(true);
    expect(
      stateOf(queryClient, arcCurrentAgentUsageQueryKey("omp", null, null)),
    ).toBe(true);
  });

  it("ignores a kind the app does not show", () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(arcAccountsQueryKey(), { accounts: [] });

    invalidateArcChangedKind(queryClient, "not-a-kind");

    expect(stateOf(queryClient, arcAccountsQueryKey())).toBe(false);
  });

  it("invalidates from the signal the app receives over the socket", () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(arcAccountsQueryKey(), { accounts: [] });
    queryClient.setQueryData(
      arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus", null),
      { resources: [] },
    );

    handleArcPluginSignal(queryClient, {
      channel: ARC_CHANGED_CHANNEL,
      payload: { kind: "accounts" },
    });

    expect(stateOf(queryClient, arcAccountsQueryKey())).toBe(true);
    expect(
      stateOf(
        queryClient,
        arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus", null),
      ),
    ).toBe(true);
  });

  it("ignores a signal that belongs to another channel or plugin", () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(arcAccountsQueryKey(), { accounts: [] });

    handleArcPluginSignal(queryClient, {
      channel: "mc-changed",
      payload: { kind: "accounts" },
    });
    handleArcPluginSignal(queryClient, {
      channel: ARC_CHANGED_CHANNEL,
      payload: null,
    });

    expect(stateOf(queryClient, arcAccountsQueryKey())).toBe(false);
  });

  it("reads the change kind out of a plugin signal payload", () => {
    expect(ARC_CHANGED_CHANNEL).toBe("arc-changed");
    expect(readArcChangedKind({ kind: "usage" })).toBe("usage");
    expect(readArcChangedKind({})).toBeNull();
    expect(readArcChangedKind({ kind: 3 })).toBeNull();
    expect(readArcChangedKind(null)).toBeNull();
    expect(readArcChangedKind("usage")).toBeNull();
  });
});

describe("arc usage query keys", () => {
  it("separates accounts and agents so one reading is never served for another", () => {
    const plus = arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus", null);
    const team = arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:team", null);
    const claude = arcCurrentAgentUsageQueryKey(
      "claude-code",
      "openai:chatgpt:plus",
      null,
    );

    expect(plus).not.toEqual(team);
    expect(plus).not.toEqual(claude);
    // An unresolved account is its own entry, never a stand-in for a real one.
    expect(arcCurrentAgentUsageQueryKey("codex", null, null)).not.toEqual(plus);
  });

  it("separates the OMP provider a thread runs on from the one it left", () => {
    const kimi = arcCurrentAgentUsageQueryKey(
      "omp",
      null,
      "kimi-code/kimi-for-coding",
    );
    const openCode = arcCurrentAgentUsageQueryKey(
      "omp",
      null,
      "opencode-go/ox-alpha-free",
    );
    const sameProviderOtherModel = arcCurrentAgentUsageQueryKey(
      "omp",
      null,
      "opencode-go/deepseek-v4-pro",
    );

    expect(kimi).not.toEqual(openCode);
    expect(openCode).not.toEqual(sameProviderOtherModel);
    // A thread whose model is not known yet is its own entry too: a late
    // answer for a real model must never be served as the unresolved one.
    expect(arcCurrentAgentUsageQueryKey("omp", null, null)).not.toEqual(kimi);
  });

  it("keeps the prefix an invalidation target for every account", () => {
    const prefix = allArcCurrentAgentUsageQueryKeyPrefix();
    const plus = arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus", null);
    expect(plus.slice(0, prefix.length)).toEqual([...prefix]);
  });
});
