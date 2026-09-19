import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderInfo } from "@bb/domain";
import {
  ARC_AGENT_PROVIDER_IDS,
  ARC_MODE_ENV,
  filterArcExecutionProviders,
} from "../../src/services/system/arc-agent-catalog.js";

const BASE_PROVIDER_INFO = {
  pluginId: "provider-stub",
  logoUrl: null,
  maintenance: { health: true, usage: true, installation: false },
  capabilities: {
    supportsThreadArchive: false,
    supportsThreadRename: false,
    supportsServiceTier: false,
    supportsNativeUserQuestion: false,
    supportsFork: false,
    supportsSessionRewind: false,
    modelCatalogScope: "workspace" as const,
    permissionModes: ["full" as const],
  },
  composerActions: [],
  completedTurnDisplay: "collapse" as const,
  available: true,
};

const FULL_ROSTER_IDS = [
  "pi",
  "codex",
  "acp-opencode",
  "claude-code",
  "acp-cursor",
  "acp-omp",
  "acp-grok",
  "acp-hermes-agent",
  "gemini",
];

const NON_ARC_PROVIDER_IDS = [
  "pi",
  "acp-opencode",
  "acp-cursor",
  "acp-grok",
  "acp-hermes-agent",
  "gemini",
];

const FULL_ROSTER: ProviderInfo[] = FULL_ROSTER_IDS.map((id) => ({
  ...BASE_PROVIDER_INFO,
  id,
  displayName: id,
}));

const NON_ARC_ROSTER: ProviderInfo[] = NON_ARC_PROVIDER_IDS.map((id) => ({
  ...BASE_PROVIDER_INFO,
  id,
  displayName: id,
}));

describe("ARC_AGENT_PROVIDER_IDS", () => {
  it("is the closed Arc catalog provider IDs in catalog order", () => {
    expect(ARC_AGENT_PROVIDER_IDS).toEqual(["acp-omp", "codex", "claude-code"]);
  });
});

describe("filterArcExecutionProviders", () => {
  describe("standalone bb (env absent)", () => {
    it("leaves the full roster unchanged", () => {
      expect(filterArcExecutionProviders(FULL_ROSTER).map((p) => p.id)).toEqual(
        [...FULL_ROSTER_IDS],
      );
    });
  });

  describe("Arc mode (env set)", () => {
    let previous: string | undefined;
    beforeEach(() => {
      previous = process.env[ARC_MODE_ENV];
      process.env[ARC_MODE_ENV] = "/tmp/arc-runtime-root";
    });
    afterEach(() => {
      if (previous === undefined) {
        delete process.env[ARC_MODE_ENV];
      } else {
        process.env[ARC_MODE_ENV] = previous;
      }
    });

    it("keeps only the Arc catalog providers, preserving roster order", () => {
      expect(filterArcExecutionProviders(FULL_ROSTER).map((p) => p.id)).toEqual(
        ["codex", "claude-code", "acp-omp"],
      );
    });

    it("drops every provider that is not in the Arc catalog", () => {
      expect(filterArcExecutionProviders(NON_ARC_ROSTER)).toEqual([]);
    });
  });
});
