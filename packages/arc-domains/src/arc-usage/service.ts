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

// Freshness policy (Phase 14). Arc never fetches a provider on a read: a read
// is a cheap metadata inventory plus the last known measurement. A background
// fill asks the owning source for a measurement only when the cached one is
// past its bound, and always without forcing, so the source's own policy (the
// pool's 5-minute interval, OMP's own usage caching) still governs vendor
// traffic. The bound matches the pool's own quota refresh interval so Arc
// cannot outpace the cache underneath it.
const MEASUREMENT_MAX_AGE_MS = 5 * 60 * 1_000;
// A failed or non-available measurement is retried sooner than a good one, but
// never on a timer: only a read that observes it as due schedules the retry.
const MEASUREMENT_ERROR_RETRY_MS = 60 * 1_000;

const SOURCE_KIND_ORDER: ArcUsageSourceKind[] = ["pool", "omp", "thread"];

// Measurement fields always come from the cache; identity fields always come
// from the fresh listing. A metadata-only inventory (the pool and OMP list
// resources without a measurement) must never drop a measurement Arc already
// has, and a fresh listing must never resurrect an identity the source no
// longer asserts. Presentation fields that the measurement itself produced
// (accountEmail, planLabel) travel with the measurement.
function withListedIdentity(
  measured: ArcUsageResource,
  listed: ArcUsageResource,
): ArcUsageResource {
  return {
    ...measured,
    id: listed.id,
    sourceKind: listed.sourceKind,
    accountKey: listed.accountKey,
    accountSourceId: listed.accountSourceId,
    providerFamily: listed.providerFamily,
    providerLabel: listed.providerLabel,
    agentIds: listed.agentIds,
    credentialDisabled: listed.credentialDisabled,
    sources: listed.sources,
  };
}

// Whether the cached measurement for a listed resource is due for a
// background refill. A provider that does not expose usage at all
// ("not-exposed") is a stable property, not staleness: it is only re-read on
// an explicit request.
function measurementRefreshDue(
  entry: CacheEntry | undefined,
  now: number,
): boolean {
  if (entry === undefined) return true;
  const age = now - entry.fetchedAt;
  const { status, unavailableReason } = entry.resource;
  if (status === "available") return age >= MEASUREMENT_MAX_AGE_MS;
  if (status === "unavailable" && unavailableReason === "not-exposed") {
    return false;
  }
  return age >= MEASUREMENT_ERROR_RETRY_MS;
}

function matchesInvalidation(
  resource: ArcUsageResource,
  filter: ArcUsageInvalidation,
): boolean {
  if (filter.resourceId !== undefined && resource.id !== filter.resourceId) {
    return false;
  }
  if (filter.sourceKind !== undefined && resource.sourceKind !== filter.sourceKind) {
    return false;
  }
  if (filter.agentId !== undefined && !resource.agentIds.includes(filter.agentId)) {
    return false;
  }
  if (filter.accountKey !== undefined && resource.accountKey !== filter.accountKey) {
    return false;
  }
  return true;
}

// Arc product catalog order (OMP, Codex, Claude Code) keeps merged agent
// lists deterministic.
function agentOrderIndex(agentId: ArcAgentId): number {
  const index = ["omp", "codex", "claude-code"].indexOf(agentId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export interface ArcUsageInvalidation {
  agentId?: ArcAgentId;
  accountKey?: string | null;
  resourceId?: string;
  sourceKind?: ArcUsageSourceKind;
}

export interface ArcUsageServiceArgs {
  sources: ArcUsageSource[];
  now?: () => number;
  onDiagnostic?: (message: string) => void;
  // Called after a background measurement fill changed what a read would
  // serve. The owner (arc-core) turns it into the renderer-visible change
  // signal; the service itself never publishes anything.
  onMeasurementsChanged?: () => void;
}

export class ArcUsageService {
  private readonly sources: ArcUsageSource[];
  private readonly now: () => number;
  private readonly onDiagnostic: ((message: string) => void) | undefined;
  private readonly onMeasurementsChanged: (() => void) | undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private inventoryInFlight: Promise<ArcUsageSnapshot> | null = null;
  private readonly measurementFills = new Map<string, Promise<unknown>>();

  constructor(args: ArcUsageServiceArgs) {
    this.sources = args.sources;
    this.now = args.now ?? Date.now;
    this.onDiagnostic = args.onDiagnostic;
    this.onMeasurementsChanged = args.onMeasurementsChanged;
  }

  // Cheap read: fresh source inventories plus the last known measurement.
  // Never contacts providers directly and never forces a refresh; a
  // measurement that is past its bound schedules a background fill instead,
  // so the read itself never blocks on a vendor call.
  async listUsageResources(): Promise<ArcUsageSnapshot> {
    const snapshot = await this.readInventoryOnce();
    this.scheduleMeasurementFill(snapshot);
    return snapshot;
  }

  // Concurrent reads (a snapshot read racing a current-agent read, or a
  // refresh's own inventory) share one source inventory instead of each
  // re-listing every source. Deliberately not a TTL cache: a read still
  // observes real source state, it just never observes it twice at once.
  private readInventoryOnce(): Promise<ArcUsageSnapshot> {
    const existing = this.inventoryInFlight;
    if (existing !== null) return existing;
    const pending = this.readInventory().finally(() => {
      if (this.inventoryInFlight === pending) this.inventoryInFlight = null;
    });
    this.inventoryInFlight = pending;
    return pending;
  }

  private async readInventory(): Promise<ArcUsageSnapshot> {
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
    const readySourceKinds = new Set<ArcUsageSourceKind>();
    let failures = 0;
    for (const result of results) {
      const checkedAt = this.now();
      if (result.ok) {
        listed.push(...result.resources);
        readySourceKinds.add(result.source.kind);
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
    this.evictVanished(listed, readySourceKinds);
    const merged = this.associate(listed.map((resource) => this.withCache(resource)));
    return { generatedAt: this.now(), resources: merged, sources: statuses };
  }

  // A resource that a healthy source no longer lists cannot keep serving a
  // cached measurement: the account behind it was removed or is gone. Only
  // sources that answered this inventory may evict, so a source outage never
  // destroys another source's last-good data.
  private evictVanished(
    listed: ArcUsageResource[],
    readySourceKinds: Set<ArcUsageSourceKind>,
  ): void {
    const listedIds = new Set(listed.map((resource) => resource.id));
    for (const [id, entry] of this.cache) {
      if (listedIds.has(id)) continue;
      if (!readySourceKinds.has(entry.resource.sourceKind)) continue;
      this.cache.delete(id);
    }
  }

  async getUsageResource(id: string): Promise<ArcUsageResource | null> {
    const snapshot = await this.listUsageResources();
    return snapshot.resources.find((resource) => resource.id === id) ?? null;
  }

  // Force a fresh provider attempt for exactly one resource. A failure with
  // prior good data yields that data marked stale; a failure with no prior
  // data yields an error-state resource (never fabricated zeros). An explicit
  // refresh forces; the background fill does not, leaving the source's own
  // interval policy in charge of vendor traffic.
  async refreshUsageResource(
    id: string,
    options: { force?: boolean; inventory?: ArcUsageSnapshot } = {},
  ): Promise<ArcUsageResource> {
    const force = options.force ?? true;
    const snapshot = options.inventory ?? (await this.readInventoryOnce());
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
      const fresh = await source.fetch(id, force);
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
  // resource (stale last-good or error state) and never fail the batch. One
  // inventory backs the whole batch, so N resources cost one listing rather
  // than N + 1.
  async refreshAllUsage(): Promise<ArcUsageSnapshot> {
    const snapshot = await this.readInventoryOnce();
    const refreshed = await Promise.all(
      snapshot.resources.map(async (resource) => {
        try {
          return await this.refreshUsageResource(resource.id, {
            force: true,
            inventory: snapshot,
          });
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

  // Drops cached measurements Arc knows are no longer trustworthy, because
  // Arc itself changed the truth behind them (an account added, removed,
  // disabled or reordered). A TTL is the wrong tool for a mutation the
  // process just performed: the next read must not be able to serve the
  // previous account's numbers.
  invalidateUsage(filter: ArcUsageInvalidation = {}): void {
    for (const [id, entry] of this.cache) {
      if (!matchesInvalidation(entry.resource, filter)) continue;
      this.cache.delete(id);
    }
  }

  // Asks the owning source for a measurement only where the cached one is
  // past its bound, one fill per resource, never blocking the read and never
  // throwing. The fill is deliberately non-forcing, and a burst of fills
  // signals once: N resources filled by one read are one change as far as
  // every subscriber is concerned, and publishing per resource would make
  // every mounted surface refetch N times.
  private scheduleMeasurementFill(snapshot: ArcUsageSnapshot): void {
    const now = this.now();
    const started: Promise<unknown>[] = [];
    for (const resource of snapshot.resources) {
      if (resource.sourceKind === "thread") continue;
      const entry = this.cache.get(resource.id);
      if (!measurementRefreshDue(entry, now)) continue;
      if (this.measurementFills.has(resource.id)) continue;
      const fill = this.refreshUsageResource(resource.id, {
        force: false,
        inventory: snapshot,
      })
        .catch((error: unknown) => {
          this.onDiagnostic?.(
            `usage measurement fill for ${resource.id} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          if (this.measurementFills.get(resource.id) === fill) {
            this.measurementFills.delete(resource.id);
          }
        });
      this.measurementFills.set(resource.id, fill);
      started.push(fill);
    }
    if (started.length === 0) return;
    void Promise.all(started).then(() => {
      this.onMeasurementsChanged?.();
    });
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

  // A listing carries identity; a measurement carries numbers. The pool and
  // OMP list resources without a measurement (status "unknown", no windows),
  // so a read must overlay the last known measurement onto the fresh listing
  // — otherwise every read drops data Arc already holds, which is what forced
  // every surface to re-fetch from a provider just to show anything. A
  // resource with no cached measurement stays "unknown" with no windows:
  // UNKNOWN != ZERO is preserved exactly.
  private withCache(resource: ArcUsageResource): ArcUsageResource {
    const prior = this.cache.get(resource.id);
    if (resource.status === "available") {
      this.cache.set(resource.id, { resource, fetchedAt: this.now() });
      return resource;
    }
    if (resource.status === "unavailable") {
      // "unavailable" is a real provider answer (not-exposed / not-connected
      // / disabled), not a fetch failure — it does not mark prior good data
      // stale, but it does not overwrite it either; keep serving the last
      // known reading.
      if (prior !== undefined && prior.resource.windows.length > 0) {
        return withListedIdentity(prior.resource, resource);
      }
      return resource;
    }
    if (prior === undefined) return resource;
    // "error" from a source that reports its own failure on list, or
    // "unknown" from a metadata-only listing: both keep the cached
    // measurement and its status, with identity refreshed from the listing.
    return withListedIdentity(prior.resource, resource);
  }
}
