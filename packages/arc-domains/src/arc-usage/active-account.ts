import type { ArcAgentId } from "../arc-agent/types.js";
import type { ArcActiveUsageAccount, ArcUsageResource } from "./types.js";

// Which account is a thread actually running on, and therefore whose quota a
// thread-scoped surface may show. Two facts are allowed to answer it, in this
// order, and nothing else:
//
// 1. the thread's own binding (the account the user picked, or the account the
//    pool resolved for the thread) — exact, so a bound thread never shows
//    another account's numbers;
// 2. for OMP, the provider that the thread's selected model id belongs to.
//    OMP namespaces every model id as "<provider>/<model>" over the same
//    provider ids its credentials carry, so the prefix is the provider the
//    next turn will execute on — not a guess from a display label.
//
// A provider whose account is still ambiguous (several connected credentials,
// or none) is reported unknown: Arc says "unknown" rather than choosing an
// account the user did not choose. Every resolution is presentation-only; it
// never routes, pins, or switches anything.

// What a thread-scoped usage surface may show, and whether Arc could name the
// account those resources belong to.
export interface ArcActiveUsageResolution {
  // The resources the caller should show for this thread.
  resources: ArcUsageResource[];
  activeAccount: ArcActiveUsageAccount | null;
  activeAccountUnknown: boolean;
}

// OMP provider ids are kebab-case segments that never contain "/", and a model
// id without a namespace ("default", or a bare vendor model) names no provider.
export function ompProviderFromModelId(
  modelId: string | null | undefined,
): string | null {
  if (typeof modelId !== "string") return null;
  const separator = modelId.indexOf("/");
  if (separator <= 0) return null;
  const provider = modelId.slice(0, separator);
  const model = modelId.slice(separator + 1);
  if (provider.length === 0 || model.length === 0) return null;
  return provider;
}

function accountRef(
  resource: ArcUsageResource,
  resolvedBy: ArcActiveUsageAccount["resolvedBy"],
): ArcActiveUsageAccount {
  return {
    accountKey: resource.accountKey,
    accountSourceId: resource.accountSourceId,
    providerLabel: resource.providerLabel,
    providerFamily: resource.providerFamily,
    planLabel: resource.planLabel,
    accountEmail: resource.accountEmail,
    resolvedBy,
  };
}

// The account picker binds a thread to `account.accountKey ?? account.id`, and
// a usage resource carries both halves of that identity — so a bound thread
// matches on either, which is what makes an OMP api-key account (no canonical
// accountKey) addressable at all.
function matchesBinding(
  resource: ArcUsageResource,
  accountKey: string,
): boolean {
  return (
    resource.accountKey === accountKey || resource.accountSourceId === accountKey
  );
}

export function resolveArcActiveUsageAccount(args: {
  agentId: ArcAgentId;
  activeAccountKey?: string | null;
  activeModelId?: string | null;
  resources: readonly ArcUsageResource[];
}): ArcActiveUsageResolution {
  const all = [...args.resources];
  const binding = args.activeAccountKey;
  if (typeof binding === "string" && binding.length > 0) {
    const bound = all.filter((resource) => matchesBinding(resource, binding));
    return {
      resources: bound,
      activeAccount: bound.length === 0 ? null : accountRef(bound[0]!, "binding"),
      activeAccountUnknown: false,
    };
  }

  if (args.agentId === "omp") {
    const provider = ompProviderFromModelId(args.activeModelId);
    if (provider !== null) {
      const candidates = all.filter(
        (resource) => resource.providerFamily === provider,
      );
      if (candidates.length === 1) {
        return {
          resources: candidates,
          activeAccount: accountRef(candidates[0]!, "provider"),
          activeAccountUnknown: false,
        };
      }
    }
  }

  // Unknown keeps the full list: a surface may offer the choice, but nothing
  // may present one of these accounts as the thread's own.
  return { resources: all, activeAccount: null, activeAccountUnknown: true };
}
