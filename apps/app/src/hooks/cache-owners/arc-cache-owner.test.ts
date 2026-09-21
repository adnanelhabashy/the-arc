import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  ARC_CHANGED_CHANNEL,
  invalidateArcAccounts,
  invalidateArcChangedKind,
  invalidateArcStatus,
  invalidateArcUsage,
  readArcChangedKind,
} from "./arc-cache-owner";
import {
  allArcCurrentAgentUsageQueryKeyPrefix,
  arcAccountsQueryKey,
  arcCurrentAgentUsageQueryKey,
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
      arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:a"),
      { resources: [] },
    );

    await invalidateArcAccounts(queryClient);

    expect(stateOf(queryClient, arcAccountsQueryKey())).toBe(true);
    expect(stateOf(queryClient, arcStatusQueryKey())).toBe(false);
    expect(
      stateOf(
        queryClient,
        arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:a"),
      ),
    ).toBe(false);

    await invalidateArcStatus(queryClient);
    await invalidateArcUsage(queryClient);
    expect(stateOf(queryClient, arcStatusQueryKey())).toBe(true);
    expect(
      stateOf(
        queryClient,
        arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:a"),
      ),
    ).toBe(true);
  });

  it("invalidates every account's usage when the account list changes", async () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(
      arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus"),
      { resources: [] },
    );
    queryClient.setQueryData(
      arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:team"),
      { resources: [] },
    );

    invalidateArcChangedKind(queryClient, "accounts");

    expect(
      stateOf(
        queryClient,
        arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus"),
      ),
    ).toBe(true);
    expect(
      stateOf(
        queryClient,
        arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:team"),
      ),
    ).toBe(true);
  });

  it("leaves account and usage caches alone for a kind the app does not show", () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(arcAccountsQueryKey(), { accounts: [] });
    queryClient.setQueryData(
      arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus"),
      { resources: [] },
    );

    // Runtime status belongs to Mission Control, which subscribes itself.
    invalidateArcChangedKind(queryClient, "agents");
    invalidateArcChangedKind(queryClient, "not-a-kind");

    expect(stateOf(queryClient, arcAccountsQueryKey())).toBe(false);
    expect(
      stateOf(
        queryClient,
        arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus"),
      ),
    ).toBe(false);
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
    const plus = arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus");
    const team = arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:team");
    const claude = arcCurrentAgentUsageQueryKey(
      "claude-code",
      "openai:chatgpt:plus",
    );

    expect(plus).not.toEqual(team);
    expect(plus).not.toEqual(claude);
    // An unresolved account is its own entry, never a stand-in for a real one.
    expect(arcCurrentAgentUsageQueryKey("codex", null)).not.toEqual(plus);
  });

  it("keeps the prefix an invalidation target for every account", () => {
    const prefix = allArcCurrentAgentUsageQueryKeyPrefix();
    const plus = arcCurrentAgentUsageQueryKey("codex", "openai:chatgpt:plus");
    expect(plus.slice(0, prefix.length)).toEqual([...prefix]);
  });
});
