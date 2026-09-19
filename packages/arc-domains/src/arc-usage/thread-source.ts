import {
  type ArcThreadContextGateway,
  type ArcUsageResource,
  type ArcUsageSource,
} from "./types.js";

// The current thread's context-window occupancy. This is token occupancy of
// the conversation's context window (used / model max), NOT provider
// subscription quota — it is modeled as its own source so the two can never
// merge. Values come straight from BB's thread context usage signal; when no
// thread context is available the resource reports "unknown" rather than
// inventing numbers.

export interface ArcThreadUsageSourceArgs {
  gateway: ArcThreadContextGateway;
  now?: () => number;
}

export class ArcThreadUsageSource implements ArcUsageSource {
  readonly kind = "thread" as const;
  private readonly gateway: ArcThreadContextGateway;
  private readonly now: () => number;
  private cache: { resource: ArcUsageResource; at: number } | null = null;

  constructor(args: ArcThreadUsageSourceArgs) {
    this.gateway = args.gateway;
    this.now = args.now ?? Date.now;
  }

  async list(): Promise<ArcUsageResource[]> {
    const current = await this.gateway.getCurrentThreadContext();
    if (current === null) {
      if (this.cache !== null) return [this.cache.resource];
      return [];
    }
    const resource = this.map(current);
    this.cache = { resource, at: this.now() };
    return [resource];
  }

  async fetch(
    resourceId: string,
    refresh: boolean,
  ): Promise<ArcUsageResource> {
    void refresh;
    void resourceId;
    const current = await this.gateway.getCurrentThreadContext();
    if (current === null) {
      if (this.cache !== null) return this.cache.resource;
      throw new Error("no current thread context is available");
    }
    const resource = this.map(current);
    this.cache = { resource, at: this.now() };
    return resource;
  }

  private map(current: {
    threadId: string;
    usedTokens: number;
    modelContextWindow: number;
    estimated: boolean;
    modelLabel: string | null;
  }): ArcUsageResource {
    const usedPercent = (current.usedTokens / current.modelContextWindow) * 100;
    return {
      id: `thread:${current.threadId}`,
      sourceKind: "thread",
      accountKey: null,
      accountSourceId: null,
      providerFamily: null,
      providerLabel: "Context",
      accountEmail: null,
      planLabel: null,
      modelLabel: current.modelLabel,
      agentIds: [],
      windows: [
        {
          id: "context",
          label: "Context window",
          kind: "custom",
          status: null,
          // A real denominator exists (the model's context window), so the
          // percentage is a true measurement, not a fabrication.
          usedPercent,
          remainingPercent: 100 - usedPercent,
          usedAmount: current.usedTokens,
          limitAmount: current.modelContextWindow,
          remainingAmount: current.modelContextWindow - current.usedTokens,
          unit: "tokens",
          resetsAt: null,
          observedAt: this.now(),
          source: null,
        },
      ],
      observedAt: this.now(),
      fetchedAt: this.now(),
      stale: false,
      status: "available",
      unavailableReason: null,
      credentialDisabled: false,
      message: current.estimated ? "Context usage is estimated." : null,
      sources: ["thread"],
    };
  }
}
