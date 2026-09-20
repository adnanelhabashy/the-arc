// Threads tab: the live thread hierarchy. Every row is BB-observed data;
// clicking a row opens the thread in BB's own UI.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import type { EnrichedThread } from "../server";
import { useTree } from "@/lib/data";
import { useProvidersList, type ProviderList } from "@/lib/bb";
import { Chip, EmptyState, ProvenanceBadge, StatusDot, compactNumber, relativeTime, type ThreadStatus } from "@/components/common";
import { ThreadQuickActions } from "@/components/quick-actions";

function rowStatus(thread: EnrichedThread): ThreadStatus {
  if (thread.pendingCount > 0 || thread.hasPendingInteraction) return "pending";
  const display = thread.runtimeDisplayStatus ?? thread.status;
  if (display === "active") return "active";
  if (display === "idle") return "idle";
  if (display === "error" || display === "failed") return "error";
  return "unknown";
}

function contextPercent(thread: EnrichedThread): number | null {
  const window = thread.context?.modelContextWindow ?? thread.usage?.modelContextWindow ?? null;
  const used = thread.context?.usedTokens ?? null;
  if (window === null || used === null || window <= 0) return null;
  return Math.min(100, Math.round((used / window) * 100));
}

function ThreadRow({ thread, depth, providers }: { thread: EnrichedThread; depth: number; providers: ProviderList }) {
  const navigate = useBbNavigate();
  const status = rowStatus(thread);
  const context = contextPercent(thread);
  const providerName = providers.find((provider) => provider.id === thread.providerId)?.displayName ?? thread.providerId;

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => navigate.toThread(thread.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") navigate.toThread(thread.id);
        }}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
        style={{ paddingLeft: `${8 + depth * 18}px` }}
        title={thread.titleFallback ?? thread.title}
      >
        <StatusDot status={status} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{thread.title}</span>
        {thread.visibility !== "visible" ? <span className="rounded border border-border px-1 text-[9px] uppercase text-muted-foreground">hidden</span> : null}
        {thread.pendingCount > 0 ? (
          <span className="rounded border border-amber-400/40 px-1 text-[10px] text-amber-400" title={thread.pendingTitles.join(" · ")}>
            {thread.pendingCount} pending
          </span>
        ) : null}
        <span className="hidden items-center gap-1 text-[11px] text-muted-foreground md:flex">
          <span className="max-w-28 truncate">{providerName}</span>
        </span>
        <span
          className={`hidden max-w-32 truncate text-[11px] md:inline ${thread.accountKey === null ? "text-muted-foreground/50" : "text-muted-foreground"}`}
          title={thread.accountLabel ?? undefined}
        >
          {thread.accountLabel ?? "Account unknown"}
        </span>
        {thread.model !== null ? (
          <span className="hidden font-mono text-[11px] text-muted-foreground lg:inline">
            {thread.model}
            {thread.reasoningLevel !== null ? ` · ${thread.reasoningLevel}` : ""}
          </span>
        ) : (
          <span className="hidden text-[11px] text-muted-foreground/50 lg:inline">no model data</span>
        )}
        {thread.usage?.total !== null && thread.usage !== null ? (
          <span className="hidden text-[11px] tabular-nums text-muted-foreground xl:inline" title="Total tokens (all turns)">
            {compactNumber(thread.usage.total?.totalTokens ?? 0)} tok
          </span>
        ) : null}
        {context !== null ? (
          <span
            className={`hidden w-10 text-right text-[11px] tabular-nums xl:inline ${context >= 85 ? "text-red-400" : context >= 65 ? "text-amber-400" : "text-muted-foreground"}`}
            title="Context window used"
          >
            {context}%
          </span>
        ) : null}
        {thread.environment?.branchName !== null && thread.environment?.branchName !== undefined ? (
          <Chip className="hidden font-mono md:inline-flex">
            <span className="size-1 rounded-full bg-emerald-400/70" />
            {thread.environment.branchName}
          </Chip>
        ) : null}
        {thread.lastAction !== null ? (
          <span className="hidden w-28 truncate text-right text-[11px] text-muted-foreground lg:inline">{thread.lastAction}</span>
        ) : null}
        <span className="w-20 text-right text-[11px] tabular-nums text-muted-foreground/70">{relativeTime(thread.updatedAt)}</span>
        <ThreadQuickActions thread={thread} />
      </div>
    </li>
  );
}

export function ThreadsPage() {
  const { data, error } = useTree();
  const providers = useProvidersList();

  if (error !== null) {
    return (
      <div className="p-4">
        <EmptyState title={`Failed to load threads: ${error}`} />
      </div>
    );
  }
  if (data === null) {
    return (
      <div className="p-4">
        <EmptyState title="Loading threads…" />
      </div>
    );
  }

  const byParent = new Map<string | null, EnrichedThread[]>();
  for (const thread of data.threads) {
    const parent = thread.parentThreadId;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(thread);
  }
  const sortByActivity = (a: EnrichedThread, b: EnrichedThread) => b.updatedAt - a.updatedAt;
  const roots = (byParent.get(null) ?? []).sort(sortByActivity);
  const childrenOf = (id: string): EnrichedThread[] => (byParent.get(id) ?? []).sort(sortByActivity);

  function renderSubtree(thread: EnrichedThread, depth: number): ReactNode {
    return (
      <div key={thread.id}>
        <ThreadRow thread={thread} depth={depth} providers={providers} />
        {childrenOf(thread.id).map((child) => renderSubtree(child, depth + 1))}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-2 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          {data.counters.total} threads · {data.counters.active} active · {data.counters.pendingInteractions} pending approvals
        </p>
        <ProvenanceBadge provenance="bb-observed" />
      </div>
      {roots.length === 0 ? (
        <EmptyState title="No threads." />
      ) : (
        <ul className="space-y-0.5">{roots.map((thread) => renderSubtree(thread, 0))}</ul>
      )}
    </div>
  );
}
