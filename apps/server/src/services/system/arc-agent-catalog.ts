import { ARC_AGENT_CATALOG } from "@bb/arc-domains/arc-agent";
import type { ProviderInfo } from "@bb/domain";

// Arc-mode declaration read from the spawned-server environment. Desktop main
// sets it (via @bb/arc-domains/arc-runtime) only on the Arc-owned child
// environment; standalone bb servers never see it.
export const ARC_MODE_ENV = "BB_ARC_RUNTIME_ROOT";

// The closed Arc catalog's BB provider IDs, in Arc catalog order (OMP, Codex,
// Claude Code). Derived from ARC_AGENT_CATALOG so upstream provider drift
// (pi, acp-opencode, acp-cursor, acp-grok, acp-hermes-agent, ...) never enters
// Arc mode. Exported for tests.
export const ARC_AGENT_PROVIDER_IDS: readonly string[] = ARC_AGENT_CATALOG.map(
  (descriptor) => descriptor.providerId,
);

const ARC_PROVIDER_ID_MEMBERSHIP: Record<string, true> = Object.fromEntries(
  ARC_AGENT_PROVIDER_IDS.map((id) => [id, true]),
);

// Presentation-only roster filter: in Arc mode, the picker (and every other
// execution-options consumer) sees only the closed Arc catalog. Standalone bb
// (env absent) is an identity — the provider registry, persisted provider IDs,
// and thread reading are never touched.
export function filterArcExecutionProviders(
  providers: ProviderInfo[],
): ProviderInfo[] {
  const runtimeRoot = process.env[ARC_MODE_ENV];
  if (runtimeRoot === undefined || runtimeRoot.length === 0) {
    return providers;
  }
  return providers.filter(
    (provider) => ARC_PROVIDER_ID_MEMBERSHIP[provider.id] === true,
  );
}
