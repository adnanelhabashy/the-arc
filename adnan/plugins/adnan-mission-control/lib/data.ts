// Shared data hooks: typed RPC + realtime invalidation + reconnect reconcile.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { ApprovalsState, EnrichedThread, MissionState, MissionValues, Probe, RoleCatalog, RoleIssue, RoleMapping, RoleMappingsState, VerificationEvidence, rpcContract } from "../server";
import type {
  ArcAccount,
  ArcAccountSourceStatus,
  ArcAgentStatus,
  ArcClaudeLoginChallenge,
  ArcOmpLoginChallenge,
  ArcOmpLoginPoll,
  ArcOmpProvider,
  ArcOpenAiLoginChallenge,
  ArcOpenAiLoginPollResult,
  ArcStatus,
  ArcUsageSnapshot,
} from "./arc-types";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const CHANNEL = "mc-changed";

export interface TreeData {
  counters: {
    total: number;
    active: number;
    idle: number;
    other: number;
    pendingInteractions: number;
    providersInUse: string[];
    generatedAt: number;
  };
  threads: EnrichedThread[];
  probe: Probe;
}

/** Fetches `tree_get` and refetches on every mc-changed signal and on
 * reconnect after a dropped socket (signals are ephemeral, never replayed). */
export function useTree(): { data: TreeData | null; isLoading: boolean; error: string | null; refresh: () => void } {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<TreeData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const connection = useRealtimeConnectionState();
  const everConnected = useRef(false);

  const load = useCallback(() => {
    let cancelled = false;
    rpc
      .call("tree_get", { includeArchived: false })
      .then((next: TreeData) => {
        if (cancelled) return;
        setData(next);
        setError(null);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    if (connection === "connected" && everConnected.current) load();
    if (connection === "connected") everConnected.current = true;
  }, [connection, load]);

  useRealtime(CHANNEL, () => {
    load();
  });

  return { data, isLoading, error, refresh: load };
}

export function useMission(): {
  state: MissionState | null;
  isLoading: boolean;
  setState: (values: Partial<MissionValues>) => Promise<void>;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setStateData] = useState<MissionState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(() => {
    let cancelled = false;
    rpc
      .call("mission_get", null)
      .then((result) => {
        if (cancelled) return;
        setStateData(result.state);
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  useEffect(() => load(), [load]);
  useRealtime(CHANNEL, () => {
    load();
  });

  const setState = useCallback(
    async (values: Partial<MissionValues>) => {
      const result = await rpc.call("mission_set", { values });
      setStateData(result.state);
    },
    [rpc],
  );

  return { state, isLoading, setState };
}

export interface RolesData {
  state: RoleMappingsState;
  catalog: RoleCatalog;
  issues: RoleIssue[];
}

export function useRoles(): {
  data: RolesData | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  save: (roles: RoleMapping[]) => Promise<RoleIssue[]>;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<RolesData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (refresh = false) => {
      let cancelled = false;
      rpc
        .call("roles_get", { refresh })
        .then((next) => {
          if (cancelled) return;
          setData(next);
          setError(null);
          setIsLoading(false);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          setIsLoading(false);
        });
      return () => {
        cancelled = true;
      };
    },
    [rpc],
  );

  useEffect(() => load(), [load]);
  useRealtime(CHANNEL, () => {
    load();
  });

  const save = useCallback(
    async (roles: RoleMapping[]) => {
      // Optimistic update: the host provider/model picker is a controlled
      // component fed `value` straight from this state. Without this, the
      // stale pre-change value is what re-renders for the length of the RPC
      // round-trip — the host reads being fed that old value back as an
      // external revert and reconciles to it, visible as "pick a non-Codex
      // model, picker snaps back to Codex and re-picks a default".
      setData((current) => (current === null ? current : { ...current, state: { ...current.state, roles } }));
      try {
        const result = await rpc.call("roles_save", { roles });
        setData((current) => (current === null ? current : { ...current, state: result.state, issues: result.issues }));
        return result.issues;
      } catch (error) {
        load();
        throw error;
      }
    },
    [rpc, load],
  );

  return { data, isLoading, error, refresh: () => load(true), save };
}

export interface ApprovalsData {
  categories: Array<{ id: string; label: string }>;
  state: ApprovalsState;
}

/** Approval Center (Phase 3): toggling here is the approval — there is no
 *  agent write path, so unlike useMission/useRoles there is nothing to
 *  reconcile beyond realtime refetch. */
export function useApprovals(): {
  data: ApprovalsData | null;
  isLoading: boolean;
  error: string | null;
  setApproved: (id: string, approved: boolean) => Promise<void>;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<ApprovalsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    rpc
      .call("approvals_get", null)
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  useEffect(() => load(), [load]);
  useRealtime(CHANNEL, () => {
    load();
  });

  const setApproved = useCallback(
    async (id: string, approved: boolean) => {
      const result = await rpc.call("approvals_set", { approvals: { [id]: approved } });
      setData((current) => (current === null ? current : { ...current, state: result.state }));
    },
    [rpc],
  );

  return { data, isLoading, error, setApproved };
}

/** Verification Guardian (Phase 4): real observed command executions, the
 *  material a user can attach as evidence — never inferred pass/fail. */
export function useEvidence(): {
  evidence: VerificationEvidence[];
  at: number | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [evidence, setEvidence] = useState<VerificationEvidence[]>([]);
  const [at, setAt] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    rpc
      .call("evidence_get", null)
      .then((result) => {
        if (cancelled) return;
        setEvidence(result.evidence);
        setAt(result.at);
        setError(null);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  useEffect(() => load(), [load]);
  useRealtime(CHANNEL, () => {
    load();
  });

  return { evidence, at, isLoading, error, refresh: load };
}

/** Quick Actions (Phase 5): every call here is a real BB mutation fired by a
 *  deliberate button click in the panel — never automatic, never on a timer. */
export function useThreadActions(): {
  send: (threadId: string, text: string, mode: "queue-if-active" | "steer-if-active") => Promise<void>;
  stop: (threadId: string) => Promise<void>;
  delegate: (threadId: string, roleId: string, prompt: string) => Promise<{ childThreadId: string }>;
} {
  const rpc = useRpc<typeof rpcContract>();
  return {
    send: async (threadId, text, mode) => {
      await rpc.call("thread_send", { threadId, text, mode });
    },
    stop: async (threadId) => {
      await rpc.call("thread_stop", { threadId });
    },
    delegate: async (threadId, roleId, prompt) => rpc.call("thread_delegate", { threadId, roleId, prompt }),
  };
}

// ---------------------------------------------------------------------------
// Arc (Phase 10) — proxied through the plugin server to arc-core.
//
// Agents, accounts, and usage are read through these hooks; mutations are
// deliberate button clicks that also refetch. arc-core publishes
// "arc-changed" after every mutation, so the read hooks also re-subscribe to
// that signal to stay fresh across surfaces.

/** Arc availability gate. `status.arcAvailable === false` means the server
 *  was not started by the Arc app and every other arc call will fail. */
export function useArcStatus(): {
  status: ArcStatus | null;
  isLoading: boolean;
  error: string | null;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<ArcStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc
      .call("arc_status", null)
      .then((result) => {
        if (cancelled) return;
        setStatus(result);
        setError(null);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  return { status, isLoading, error };
}

export function useArcAgents(): {
  agents: ArcAgentStatus[] | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  prepare: (id: string) => Promise<ArcAgentStatus>;
  repair: (id: string) => Promise<ArcAgentStatus>;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [agents, setAgents] = useState<ArcAgentStatus[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    rpc
      .call("arc_agents_list", null)
      .then((result) => {
        if (cancelled) return;
        setAgents((result as { agents: ArcAgentStatus[] }).agents);
        setError(null);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  useEffect(() => load(), [load]);
  useRealtime("arc-changed", () => {
    load();
  });

  const prepare = useCallback(
    async (id: string) => {
      const result = (await rpc.call("arc_agents_prepare", { id })) as { agent: ArcAgentStatus };
      load();
      return result.agent;
    },
    [rpc, load],
  );

  const repair = useCallback(
    async (id: string) => {
      const result = (await rpc.call("arc_agents_repair", { id })) as { agent: ArcAgentStatus };
      load();
      return result.agent;
    },
    [rpc, load],
  );

  return { agents, isLoading, error, refresh: load, prepare, repair };
}

export function useArcAccounts(): {
  accounts: ArcAccount[] | null;
  sources: ArcAccountSourceStatus[] | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  setEnabled: (id: string, enabled: boolean) => Promise<ArcAccount>;
  remove: (id: string) => Promise<void>;
  reorder: (family: string, orderedIds: string[]) => Promise<void>;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [accounts, setAccounts] = useState<ArcAccount[] | null>(null);
  const [sources, setSources] = useState<ArcAccountSourceStatus[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    rpc
      .call("arc_accounts_list", null)
      .then((result) => {
        if (cancelled) return;
        const data = result as { accounts: ArcAccount[]; sources: ArcAccountSourceStatus[] };
        setAccounts(data.accounts);
        setSources(data.sources);
        setError(null);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  useEffect(() => load(), [load]);
  useRealtime("arc-changed", () => {
    load();
  });

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      const result = (await rpc.call("arc_accounts_set_enabled", { id, enabled })) as { account: ArcAccount };
      load();
      return result.account;
    },
    [rpc, load],
  );

  const remove = useCallback(
    async (id: string) => {
      await rpc.call("arc_accounts_remove", { id });
      load();
    },
    [rpc, load],
  );

  const reorder = useCallback(
    async (family: string, orderedIds: string[]) => {
      await rpc.call("arc_accounts_reorder", { family, orderedIds });
      load();
    },
    [rpc, load],
  );

  return { accounts, sources, isLoading, error, refresh: load, setEnabled, remove, reorder };
}

export function useArcOmpProviders(): {
  providers: ArcOmpProvider[] | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [providers, setProviders] = useState<ArcOmpProvider[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    rpc
      .call("arc_omp_providers", null)
      .then((result) => {
        if (cancelled) return;
        setProviders((result as { providers: ArcOmpProvider[] }).providers);
        setError(null);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  useEffect(() => load(), [load]);

  return { providers, isLoading, error, refresh: load };
}

/** Arc usage: fetched on demand (tab open / Refresh click). No polling, no
 *  realtime signal — usage is expensive; the page adds its own slow tick for
 *  relative-time rendering. `refreshResource` refetches a single resource
 *  after an inline Retry. */
export function useArcUsage(): {
  data: ArcUsageSnapshot | null;
  isLoading: boolean;
  isFetching: boolean;
  error: string | null;
  refresh: () => void;
  refreshResource: (resourceId: string) => Promise<void>;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<ArcUsageSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setIsFetching(true);
    rpc
      .call("arc_usage_snapshot", null)
      .then((result) => {
        if (cancelled) return;
        setData(result as ArcUsageSnapshot);
        setError(null);
        setIsLoading(false);
        setIsFetching(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
        setIsFetching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  useEffect(() => load(), [load]);

  const refreshResource = useCallback(
    async (resourceId: string) => {
      const result = (await rpc.call("arc_usage_refresh", { resourceId })) as ArcUsageSnapshot;
      setData(result);
    },
    [rpc],
  );

  return { data, isLoading, isFetching, error, refresh: load, refreshResource };
}

/** Login flows (ChatGPT device code, Claude OAuth paste, OMP oauth/api-key).
 *  Raw actions only — the polling state machine lives in the connect-flows
 *  components. Secrets are never stored: the api-key input value is passed
 *  straight through and immediately discarded. */
export function useArcLogin(): {
  openaiStart: () => Promise<ArcOpenAiLoginChallenge>;
  openaiPoll: (sessionId: string) => Promise<ArcOpenAiLoginPollResult>;
  openaiCancel: (sessionId: string) => Promise<void>;
  claudeStart: () => Promise<ArcClaudeLoginChallenge>;
  claudeComplete: (sessionId: string, pasted: string) => Promise<ArcAccount>;
  ompStart: (provider: string) => Promise<ArcOmpLoginChallenge>;
  ompPoll: (sessionId: string) => Promise<ArcOmpLoginPoll>;
  ompCancel: (sessionId: string) => Promise<void>;
  ompSubmitKey: (sessionId: string, key: string) => Promise<void>;
} {
  const rpc = useRpc<typeof rpcContract>();
  return {
    openaiStart: async () =>
      ((await rpc.call("arc_login_openai_start", null)) as { challenge: ArcOpenAiLoginChallenge }).challenge,
    openaiPoll: async (sessionId) => (await rpc.call("arc_login_openai_poll", { sessionId })) as ArcOpenAiLoginPollResult,
    openaiCancel: async (sessionId) => {
      await rpc.call("arc_login_openai_cancel", { sessionId });
    },
    claudeStart: async () =>
      ((await rpc.call("arc_login_claude_start", null)) as { challenge: ArcClaudeLoginChallenge }).challenge,
    claudeComplete: async (sessionId, pasted) =>
      ((await rpc.call("arc_login_claude_complete", { sessionId, pasted })) as { account: ArcAccount }).account,
    ompStart: async (provider) =>
      ((await rpc.call("arc_omp_login_start", { provider })) as { challenge: ArcOmpLoginChallenge }).challenge,
    ompPoll: async (sessionId) =>
      ((await rpc.call("arc_omp_login_poll", { sessionId })) as { poll: ArcOmpLoginPoll }).poll,
    ompCancel: async (sessionId) => {
      await rpc.call("arc_omp_login_cancel", { sessionId });
    },
    ompSubmitKey: async (sessionId, key) => {
      await rpc.call("arc_omp_login_submit_key", { sessionId, key });
    },
  };
}

