import type { ArcAgentId } from "../arc-agent/types.js";
import {
  ArcUsageError,
  type ArcCurrentAgentUsage,
  type ArcUsageResource,
  type ArcUsageSnapshot,
  type ArcUsageSource,
  type ArcUsageSourceKind,
  type ArcUsageSourceStatus,
  type ArcUsageWindow,
} from "./types.js";

// Arc's unified "Usage & Limits" service. Aggregates ArcUsageSource
// implementations (Account Pool, OMP, thread context) behind one generic
// resource model with:
//
// - per-resource last-good cache: a failed refresh keeps the previous
//   successful reading and marks it stale — known data is never replaced
//   with zeros or "no usage";
// - source failure isolation: one source failing never destroys another
//   source's resources;
// - conservative association: resources sharing an identical non-null
//   canonical accountKey merge into one logical resource with full source
//   provenance. Email is never identity, and a null accountKey is always
//   source-local (never deduplicated across sources);
// - observational reads only: listing usage never logs in, switches
//   accounts, changes routing, or mutates credentials.

interface CacheEntry {
  resource: ArcUsageResource;
  fetchedAt: number;
}

const SOURCE_KIND_ORDER: ArcUsageSourceKind[] = ["pool", "omp", "thread"];

// Arc product catalog order (OMP, Codex, Claude Code) keeps merged agent
// lists deterministic.
function agentOrderIndex(agentId: ArcAgentId): number {
  const index = ["omp", "codex", "claude-code"].indexOf(agentId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export interface ArcUsageServiceArgs {
  sources: ArcUsageSource[];
  now?: () => number;
  onDiagnostic?: (message: string) => void;
}

export class ArcUsageService {
  private readonly sources: ArcUsageSource[];
  private readonly now: () => number;
  private readonly onDiagnostic: ((message: string) => void) | undefined;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(args: ArcUsageServiceArgs) {
    this.sources = args.sources;
    this.now = args.now ?? Date.now;
    this.onDiagnostic = args.onDiagnostic;
  }

  // Cheap read: fresh source inventories plus cached measurements. Never
  // contacts providers and never refreshes quota (§ refresh APIs).
  async listUsageResources(): Promise<ArcUsageSnapshot> {
    const results = await Promise.all(
      this.sources.map(async (source) => {
        try {
          return { ok: true as const, source, resources: await source.list() };
        } catch (error) {
          return { ok: false as const, source, error };
        }
      }),
    );
    const listed: ArcUsageResource[] = [];
    const statuses: ArcUsageSourceStatus[] = [];
    let failures = 0;
    for (const result of results) {
      const checkedAt = this.now();
      if (result.ok) {
        listed.push(...result.resources);
        statuses.push({ kind: result.source.kind, state: "ready", detail: null, checkedAt });
        continue;
      }
      failures += 1;
      const message =
        result.error instanceof Error
          ? result.error.message
          : String(result.error);
      this.onDiagnostic?.(
        `usage source ${result.source.kind} failed: ${message}`,
      );
      statuses.push({
        kind: result.source.kind,
        state: "unavailable",
        detail: message,
        checkedAt,
      });
    }
    if (this.sources.length > 0 && failures === this.sources.length) {
      throw new ArcUsageError(
        "usage-source-unavailable",
        `every usage source failed: ${statuses
          .map((status) => `${status.kind}: ${status.detail}`)
          .join("; ")}`,
      );
    }
    const merged = this.associate(listed.map((resource) => this.withCache(resource)));
    return { generatedAt: this.now(), resources: merged, sources: statuses };
  }

  async getUsageResource(id: string): Promise<ArcUsageResource | null> {
    const snapshot = await this.listUsageResources();
    return snapshot.resources.find((resource) => resource.id === id) ?? null;
  }

  // Force a fresh provider attempt for exactly one resource. A failure with
  // prior good data yields that data marked stale; a failure with no prior
  // data yields an error-state resource (never fabricated zeros).
  async refreshUsageResource(id: string): Promise<ArcUsageResource> {
    const snapshot = await this.listUsageResources();
    const target = snapshot.resources.find((resource) => resource.id === id);
    if (target === undefined) {
      throw new ArcUsageError(
        "usage-resource-not-found",
        `usage resource ${id} is not listed by any source`,
      );
    }
    const primary = target.sources[0];
    const source = this.sources.find((entry) => entry.kind === primary);
    if (source === undefined) {
      throw new ArcUsageError(
        "usage-resource-not-found",
        `no source backs usage resource ${id}`,
      );
    }
    try {
      const fresh = await source.fetch(id, true);
      const resource = this.associate([this.withCache({ ...fresh, stale: false })])[0]!;
      this.cache.set(id, { resource, fetchedAt: this.now() });
      return resource;
    } catch (error) {
      const prior = this.cache.get(id);
      if (prior !== undefined) {
        const staleResource = { ...prior.resource, stale: true };
        this.cache.set(id, { resource: staleResource, fetchedAt: prior.fetchedAt });
        return staleResource;
      }
      const failed: ArcUsageResource = {
        ...target,
        status: "error",
        message:
          error instanceof ArcUsageError
            ? error.message
            : "Usage refresh failed.",
        windows: target.windows,
        stale: false,
      };
      this.cache.set(id, { resource: failed, fetchedAt: this.now() });
      return failed;
    }
  }

  // Refreshes every listed resource; per-resource failures degrade only that
  // resource (stale last-good or error state) and never fail the batch.
  async refreshAllUsage(): Promise<ArcUsageSnapshot> {
    const snapshot = await this.listUsageResources();
    const refreshed = await Promise.all(
      snapshot.resources.map(async (resource) => {
        try {
          return await this.refreshUsageResource(resource.id);
        } catch {
          return resource;
        }
      }),
    );
    return {
      generatedAt: this.now(),
      resources: this.associate(refreshed),
      sources: snapshot.sources,
    };
  }

  // Resolves what Phase 10's popup needs first: the current thread's
  // context plus every usage resource for the active agent. Active-account
  // identity is not invented: when the caller cannot supply it, all of the
  // agent's resources are returned and activeAccountUnknown is true.
  async getCurrentAgentUsage(args: {
    agentId: ArcAgentId;
    activeAccountKey?: string | null;
  }): Promise<ArcCurrentAgentUsage> {
    const snapshot = await this.listUsageResources();
    const thread =
      snapshot.resources.find((resource) => resource.sourceKind === "thread") ??
      null;
    const resources = snapshot.resources.filter(
      (resource) =>
        resource.sourceKind !== "thread" &&
        resource.agentIds.includes(args.agentId),
    );
    const activeAccountUnknown = args.activeAccountKey === undefined;
    const focused =
      args.activeAccountKey != null
        ? resources.filter(
            (resource) =>
              resource.accountKey === null ||
              resource.accountKey === args.activeAccountKey,
          )
        : resources;
    return {
      agentId: args.agentId,
      thread,
      resources: focused,
      activeAccountUnknown,
    };
  }

  // Cross-source association: identical non-null canonical accountKey means
  // one logical account; resources merge with full provenance. Windows with
  // the same semantic key (kind + label) from different sources keep the
  // newer observation (by observedAt, then fetchedAt); distinct windows are
  // preserved side by side with per-window provenance. Email is never used,
  // and null accountKeys are always distinct.
  private associate(resources: ArcUsageResource[]): ArcUsageResource[] {
    const groups = new Map<string, ArcUsageResource[]>();
    const passthrough: ArcUsageResource[] = [];
    for (const resource of resources) {
      if (resource.accountKey === null) {
        passthrough.push(resource);
        continue;
      }
      const group = groups.get(resource.accountKey);
      if (group === undefined) groups.set(resource.accountKey, [resource]);
      else group.push(resource);
    }
    const merged: ArcUsageResource[] = [...passthrough];
    for (const group of groups.values()) {
      if (group.length === 1) {
        merged.push(group[0]!);
        continue;
      }
      const sorted = [...group].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      const primary = sorted[0]!;
      const windows = new Map<string, { window: ArcUsageWindow; stamp: number }>();
      for (const resource of sorted) {
        for (const window of resource.windows) {
          const key = `${window.kind}:${window.label}`;
          const existing = windows.get(key);
          const stamp = window.observedAt ?? resource.fetchedAt ?? 0;
          const candidate = { window: { ...window, source: resource.sourceKind }, stamp };
          if (existing === undefined || stamp >= existing.stamp) {
            windows.set(key, candidate);
          }
        }
      }
      merged.push({
        ...primary,
        agentIds: [
          ...new Set(sorted.flatMap((resource) => resource.agentIds)),
        ].sort(
          (a, b) => agentOrderIndex(a) - agentOrderIndex(b),
        ),
        sources: sorted
          .map((resource) => resource.sourceKind)
          .sort(
            (a, b) => SOURCE_KIND_ORDER.indexOf(a) - SOURCE_KIND_ORDER.indexOf(b),
          ),
        windows: [...windows.values()].map((entry) => entry.window),
        stale: sorted.some((resource) => resource.stale),
      });
    }
    return merged;
  }

  private withCache(resource: ArcUsageResource): ArcUsageResource {
    if (resource.status !== "available" && resource.status !== "unavailable") {
      return resource;
    }
    const prior = this.cache.get(resource.id);
    if (resource.status === "available") {
      const entry = { resource, fetchedAt: this.now() };
      this.cache.set(resource.id, entry);
      return resource;
    }
    // "unavailable" is a real provider answer (not-exposed / not-connected),
    // not a fetch failure — it does not mark prior good data stale, but it
    // does not overwrite it either; keep serving the last known reading.
    if (prior !== undefined && prior.resource.windows.length > 0) {
      return { ...prior.resource, fetchedAt: resource.fetchedAt };
    }
    return resource;
  }
}
