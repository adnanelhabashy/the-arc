import { describe, expect, it } from "vitest";
import {
  ARC_AGENT_CATALOG,
  getArcAgentDescriptor,
} from "../src/arc-agent/catalog.js";

describe("ARC_AGENT_CATALOG", () => {
  it("contains exactly three Arc agents", () => {
    expect(ARC_AGENT_CATALOG).toHaveLength(3);
  });

  it("lists OMP, Codex, and Claude Code in a stable documented order", () => {
    expect(ARC_AGENT_CATALOG.map((descriptor) => descriptor.id)).toEqual([
      "omp",
      "codex",
      "claude-code",
    ]);
  });

  it("maps Arc agent IDs to the correct runtime and BB provider IDs", () => {
    const byId = new Map(
      ARC_AGENT_CATALOG.map((descriptor) => [descriptor.id, descriptor]),
    );
    expect(byId.get("omp")).toMatchObject({
      displayName: "OMP",
      runtimeId: "omp",
      providerId: "acp-omp",
      runtimeStrategy: "bundled-managed",
    });
    expect(byId.get("codex")).toMatchObject({
      displayName: "Codex",
      runtimeId: "codex",
      providerId: "codex",
      runtimeStrategy: "bundled-managed",
    });
    expect(byId.get("claude-code")).toMatchObject({
      displayName: "Claude Code",
      runtimeId: "claude-code",
      providerId: "claude-code",
      runtimeStrategy: "official-managed",
    });
  });

  it("excludes Pi, OpenCode, Cursor, and every other upstream BB provider", () => {
    const ids = ARC_AGENT_CATALOG.map((descriptor) => descriptor.id);
    const providerIds = ARC_AGENT_CATALOG.map(
      (descriptor) => descriptor.providerId,
    );
    for (const excluded of ["pi", "acp-opencode", "acp-cursor"]) {
      expect(ids).not.toContain(excluded);
      expect(providerIds).not.toContain(excluded);
    }
  });

  it("keeps Arc agent IDs and BB provider IDs distinct concepts", () => {
    const omp = getArcAgentDescriptor("omp");
    expect(omp?.id).toBe("omp");
    expect(omp?.providerId).toBe("acp-omp");
    expect(omp?.id).not.toBe(omp?.providerId);
  });

  it("carries no account or model information in descriptors", () => {
    for (const descriptor of ARC_AGENT_CATALOG) {
      expect(descriptor).not.toHaveProperty("account");
      expect(descriptor).not.toHaveProperty("model");
      expect(descriptor).not.toHaveProperty("credentials");
    }
  });
});
