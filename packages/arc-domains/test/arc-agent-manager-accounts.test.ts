import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArcAgentManager,
  type ArcAgentAccountStatusSource,
} from "../src/arc-agent/manager.js";
import { ServiceArcAccountStatusSource } from "../src/arc-account/agent-status-source.js";
import { ArcAccountService } from "../src/arc-account/service.js";
import type { ArcAccount, ArcAccountSource } from "../src/arc-account/types.js";
import type {
  ArcAgentAccountState,
  ArcAgentId,
  ArcAgentOverallState,
} from "../src/arc-agent/types.js";
import {
  readArcRuntimeManifest,
  writeArcRuntimeManifest,
  type ArcRuntimeManifest,
} from "../src/arc-runtime/manifest.js";
import {
  createArcRuntimePaths,
  type ArcRuntimePaths,
} from "../src/arc-runtime/paths.js";
import type { ArcRuntimeId } from "../src/arc-runtime/types.js";
import { ARC_RUNTIME_RELEASES } from "../src/arc-runtime/releases.js";

const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";

const PINNED_VERSIONS: Record<ArcRuntimeId, string> = {
  codex: "0.155.1",
  omp: "18.2.6",
  "claude-code": "2.1.276",
};

const tempDirs: string[] = [];

function unimplemented(): never {
  throw new Error("not used by this test");
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-agent-accounts-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Fixture {
  paths: ArcRuntimePaths;
}

async function makeFixture(): Promise<Fixture> {
  const root = await tempDir();
  const paths = createArcRuntimePaths({ userDataPath: join(root, "userData") });
  return { paths };
}

async function writeRunnableExecutable(path: string, probeOutput: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\necho "${probeOutput}"\n`, "utf8");
  await chmod(path, 0o755);
}

async function readManifest(paths: ArcRuntimePaths): Promise<ArcRuntimeManifest> {
  const result = await readArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    manifestPath: paths.manifestPath,
    platform: PLATFORM,
  });
  if (result.kind !== "ok" && result.kind !== "missing") {
    throw new Error(`expected a readable manifest, got ${result.kind}`);
  }
  return result.manifest;
}

/** Stages the companions the pinned release requires, so a fixture that means
 *  "a healthy install" is one. */
async function stagePinnedCompanions(
  paths: ArcRuntimePaths,
  runtimeId: ArcRuntimeId,
  version: string,
): Promise<void> {
  const release = ARC_RUNTIME_RELEASES.find(
    (candidate) => candidate.runtimeId === runtimeId,
  );
  for (const companion of release?.companions ?? []) {
    await writeRunnableExecutable(
      paths.componentPath(runtimeId, version, companion.fileName),
      companion.fileName,
    );
  }
}

async function activateRuntime(
  fixture: Fixture,
  runtimeId: ArcRuntimeId,
): Promise<void> {
  const version = PINNED_VERSIONS[runtimeId];
  const manifest = await readManifest(fixture.paths);
  manifest.runtimes[runtimeId] = {
    activeVersion: version,
    previousVersion: null,
    knownGoodVersion: version,
    source:
      runtimeId === "claude-code" ? "official-managed-install" : "arc-bundled",
    digest: "0".repeat(64),
    componentsByVersion: {},
    installedAt: 1,
  };
  await writeArcRuntimeManifest({
    manifest,
    manifestPath: fixture.paths.manifestPath,
  });
  await writeRunnableExecutable(
    fixture.paths.executablePath(runtimeId, version),
    `${runtimeId} ${version}`,
  );
  await stagePinnedCompanions(fixture.paths, runtimeId, version);
}

function accountSourceFor(
  states: Partial<Record<ArcAgentId, ArcAgentAccountState>>,
): ArcAgentAccountStatusSource {
  return {
    async getAccountState(agentId: ArcAgentId): Promise<ArcAgentAccountState> {
      if (agentId === "omp") {
        throw new Error("account source must not be consulted for OMP");
      }
      return states[agentId] ?? "unknown";
    },
  };
}

async function statusFor(
  fixture: Fixture,
  id: ArcAgentId,
  states: Partial<Record<ArcAgentId, ArcAgentAccountState>>,
) {
  const manager = new ArcAgentManager({
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
    runtimePaths: fixture.paths,
    accountStatusSource: accountSourceFor(states),
  });
  return manager.getArcAgent(id);
}

function connectAccountAction(status: {
  actions: Array<{ id: string; available: boolean; reason?: string }>;
}) {
  const action = status.actions.find((entry) => entry.id === "connect-account");
  if (action === undefined) throw new Error("connect-account action missing");
  return action;
}

describe("ArcAgentManager account integration", () => {
  it("Codex ready + no account → account-required; + connected → ready", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "codex");

    const withoutAccount = await statusFor(fixture, "codex", {
      codex: "not-connected",
    });
    expect(withoutAccount.runtime.state).toBe("ready");
    expect(withoutAccount.account.state).toBe("not-connected");
    expect(withoutAccount.overallState).toBe("account-required");

    const withAccount = await statusFor(fixture, "codex", {
      codex: "connected",
    });
    expect(withAccount.overallState).toBe("ready");
  });

  it("Claude Code ready + no account → account-required; + connected → ready", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "claude-code");

    const withoutAccount = await statusFor(fixture, "claude-code", {
      "claude-code": "not-connected",
    });
    expect(withoutAccount.account.state).toBe("not-connected");
    expect(withoutAccount.overallState).toBe("account-required");

    const withAccount = await statusFor(fixture, "claude-code", {
      "claude-code": "connected",
    });
    expect(withAccount.overallState).toBe("ready");
  });

  it("a ChatGPT account does not make Claude Code connected and vice versa", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "codex");
    await activateRuntime(fixture, "claude-code");

    const codexStatus = await statusFor(fixture, "codex", {
      codex: "connected",
      "claude-code": "not-connected",
    });
    expect(codexStatus.overallState).toBe("ready");

    const claudeStatus = await statusFor(fixture, "claude-code", {
      codex: "connected",
      "claude-code": "not-connected",
    });
    expect(claudeStatus.account.state).toBe("not-connected");
    expect(claudeStatus.overallState).toBe("account-required");
  });

  it("expired or erroring accounts stay conservative (runtime-ready), not ready", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "codex");

    for (const state of ["expired", "error", "unknown"] as const) {
      const status = await statusFor(fixture, "codex", { codex: state });
      expect(status.overallState satisfies ArcAgentOverallState).toBe(
        "runtime-ready",
      );
      expect(status.overallState).not.toBe("ready");
      expect(status.overallState).not.toBe("account-required");
    }
  });

  it("runtime problems still dominate the overall state", async () => {
    const fixture = await makeFixture();
    // No manifest at all: not-prepared regardless of account state.
    const status = await statusFor(fixture, "codex", { codex: "connected" });
    expect(status.runtime.state).toBe("not-prepared");
    expect(status.overallState).toBe("not-prepared");
  });

  it("OMP stays account-unknown without an OMP source and connect-account waits for state", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "omp");

    // Even with connected ChatGPT + Claude accounts in the pool, the real
    // account status source keeps OMP account-unknown (Phase 8 owns OMP).
    const poolAccounts: ArcAccount[] = [
      {
        id: "pool:chatgpt-1",
        sourceId: "chatgpt-1",
        sourceKind: "pool",
        providerFamily: "openai",
        providerLabel: "ChatGPT",
        accountKey: "openai:chatgpt:1",
        identityKey: null,
        email: "a@example.com",
        planLabel: "plus",
        authState: "connected",
        enabled: true,
        availableThrough: ["codex"],
        observedAt: 1,
      },
      {
        id: "pool:claude-1",
        sourceId: "claude-1",
        sourceKind: "pool",
        providerFamily: "anthropic",
        providerLabel: "Claude",
        accountKey: "anthropic:account:1",
        identityKey: null,
        email: "a@example.com",
        planLabel: "max",
        authState: "connected",
        enabled: true,
        availableThrough: ["claude-code"],
        observedAt: 1,
      },
    ];
    const poolSource: ArcAccountSource = {
      kind: "pool",
      async listAccounts() {
        return poolAccounts;
      },
      getAccount: unimplemented,
      setAccountEnabled: unimplemented,
      removeAccount: unimplemented,
      setAccountPriority: unimplemented,
      reorderAccounts: unimplemented,
      startOpenAiLogin: unimplemented,
      pollOpenAiLogin: unimplemented,
      cancelOpenAiLogin: unimplemented,
      startClaudeLogin: unimplemented,
      completeClaudeLogin: unimplemented,
    };
    const source = new ServiceArcAccountStatusSource(
      new ArcAccountService({ sources: [poolSource] }),
    );
    const manager = new ArcAgentManager({
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: fixture.paths,
      accountStatusSource: source,
    });
    const status = await manager.getArcAgent("omp");
    expect(status.account.state).toBe("unknown");
    expect(status.overallState).toBe("runtime-ready");
    // Phase 8: OMP supports account connection, but with no OMP account
    // source wired and account state unknown the action is not actionable.
    expect(connectAccountAction(status)).toMatchObject({
      available: false,
      reason: "account state is unknown",
    });
  });

  it("connect-account is available exactly when an account action makes sense", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "codex");

    const notConnected = await statusFor(fixture, "codex", {
      codex: "not-connected",
    });
    expect(connectAccountAction(notConnected).available).toBe(true);

    for (const state of ["expired", "error"] as const) {
      const status = await statusFor(fixture, "codex", { codex: state });
      expect(connectAccountAction(status).available).toBe(true);
    }

    const connected = await statusFor(fixture, "codex", {
      codex: "connected",
    });
    expect(connectAccountAction(connected)).toMatchObject({
      available: false,
      reason: "an account is already connected",
    });

    const unknown = await statusFor(fixture, "codex", { codex: "unknown" });
    expect(connectAccountAction(unknown).available).toBe(false);
  });

  it("status reads stay side-effect-free with an account source attached", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "codex");
    let accountReads = 0;
    const source: ArcAgentAccountStatusSource = {
      async getAccountState(): Promise<ArcAgentAccountState> {
        accountReads += 1;
        return "not-connected";
      },
    };
    const manager = new ArcAgentManager({
      createdByArcVersion: CREATED_BY,
      platform: PLATFORM,
      runtimePaths: fixture.paths,
      accountStatusSource: source,
    });
    const before = await readManifest(fixture.paths);
    await manager.listArcAgents();
    const after = await readManifest(fixture.paths);
    expect(after).toEqual(before);
    expect(accountReads).toBe(3);
  });
});
