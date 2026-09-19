import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../src/server.js";

const ENV_KEYS = [
  "BB_ARC_RUNTIME_ROOT",
  "BB_ARC_APP_VERSION",
  "BB_ARC_SEED_ROOT",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function setArcEnv(root: string | null): void {
  for (const key of ENV_KEYS) {
    if (root === null) {
      delete process.env[key];
    } else if (key === "BB_ARC_RUNTIME_ROOT") {
      process.env[key] = root;
    } else {
      process.env[key] = "test";
    }
  }
}

describe("arc-core plugin", () => {
  let tempRoots: string[] = [];

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    for (const root of tempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    tempRoots = [];
  });

  it("reports arc-unavailable when the env contract is absent", async () => {
    setArcEnv(null);
    const host = createFakePluginHost();
    const harness = host.harness;
    await plugin(host.bb);

    await expect(harness.callRpc("arc.status", null)).resolves.toEqual({
      arcAvailable: false,
      reason: "This server was not started by the Arc app.",
    });
    await expect(harness.callRpc("arc.agents.list", null)).rejects.toThrow(
      /arc-unavailable/u,
    );
    await expect(harness.callRpc("arc.usage.snapshot", null)).rejects.toThrow(
      /arc-unavailable/u,
    );
  });

  it("reports available and builds the host when the env contract is present", async () => {
    const root = mkdtempSync(join(tmpdir(), "arc-core-test-"));
    tempRoots.push(root);
    setArcEnv(root);
    const host = createFakePluginHost();
    const harness = host.harness;
    await plugin(host.bb);

    await expect(harness.callRpc("arc.status", null)).resolves.toEqual({
      arcAvailable: true,
      reason: null,
    });
  });

  it("registers the fixed contract methods and nothing arbitrary", async () => {
    setArcEnv(null);
    const host = createFakePluginHost();
    const harness = host.harness;
    await plugin(host.bb);

    const methods = harness.registrations.rpcMethods.sort();
    expect(methods).toEqual(
      [
        "arc.accounts.list",
        "arc.accounts.remove",
        "arc.accounts.reorder",
        "arc.accounts.setEnabled",
        "arc.agents.get",
        "arc.agents.list",
        "arc.agents.prepare",
        "arc.agents.repair",
        "arc.login.claude.complete",
        "arc.login.claude.start",
        "arc.login.openai.cancel",
        "arc.login.openai.poll",
        "arc.login.openai.start",
        "arc.omp.login.cancel",
        "arc.omp.login.poll",
        "arc.omp.login.start",
        "arc.omp.login.submitKey",
        "arc.omp.providers",
        "arc.status",
        "arc.usage.current",
        "arc.usage.refresh",
        "arc.usage.snapshot",
      ].sort(),
    );
    // No generic/exec/command surface may exist alongside the fixed set.
    expect(methods.some((method) => /exec|command|shell|spawn/iu.test(method))).toBe(
      false,
    );
  });
});
