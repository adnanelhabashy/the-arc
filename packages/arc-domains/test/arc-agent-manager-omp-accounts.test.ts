import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArcAgentManager,
} from "../src/arc-agent/manager.js";
import { ARC_AGENT_CATALOG } from "../src/arc-agent/catalog.js";
import { ServiceArcAccountStatusSource } from "../src/arc-account/agent-status-source.js";
import { ArcAccountService } from "../src/arc-account/service.js";
import type {
  ArcAccount,
  ArcAccountSource,
} from "../src/arc-account/types.js";
import type {
  ArcAgentOverallState,
  ArcAgentStatus,
} from "../src/arc-agent/types.js";
import {
  readArcRuntimeManifest,
  writeArcRuntimeManifest,
} from "../src/arc-runtime/manifest.js";
import {
  createArcRuntimePaths,
  type ArcRuntimePaths,
} from "../src/arc-runtime/paths.js";
import type { ArcRuntimeId } from "../src/arc-runtime/types.js";

const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";

const PINNED_VERSIONS: Record<ArcRuntimeId, string> = {
  codex: "0.155.1",
  omp: "18.2.6",
  "claude-code": "2.1.276",
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-agent-omp-accounts-test-"));
  tempDirs.push(dir);
  return dir;
}

interface Fixture {
  paths: ArcRuntimePaths;
}

async function makeFixture(): Promise<Fixture> {
  const root = await tempDir();
  const paths = createArcRuntimePaths({ userDataPath: join(root, "userData") });
  return { paths };
}

async function writeRunnableExecutable(path: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\necho ok\n", "utf8");
  await chmod(path, 0o755);
}

async function activateRuntime(fixture: Fixture, runtimeId: ArcRuntimeId) {
  const version = PINNED_VERSIONS[runtimeId];
  const result = await readArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    manifestPath: fixture.paths.manifestPath,
    platform: PLATFORM,
  });
  if (result.kind !== "ok" && result.kind !== "missing") {
    throw new Error(`expected a readable manifest, got ${result.kind}`);
  }
  const manifest = result.manifest;
  manifest.runtimes[runtimeId] = {
    activeVersion: version,
    previousVersion: null,
    source:
      runtimeId === "claude-code" ? "official-managed-install" : "arc-bundled",
    digest: "0".repeat(64),
    installedAt: 1,
  };
  await writeArcRuntimeManifest({
    manifest,
    manifestPath: fixture.paths.manifestPath,
  });
  await writeRunnableExecutable(fixture.paths.executablePath(runtimeId, version));
}

function ompAccount(overrides: Partial<ArcAccount> = {}): ArcAccount {
  return {
    id: "omp:kimi-code:7",
    sourceId: "kimi-code:7",
    sourceKind: "omp",
    providerFamily: "kimi-code",
    providerLabel: "Kimi Code",
    accountKey: "omp:kimi-code:k1",
    identityKey: "account:k1",
    email: "kimi@example.com",
    planLabel: null,
    authState: "connected",
    enabled: true,
    availableThrough: ["omp"],
    observedAt: 1,
    ...overrides,
  };
}

// Minimal OMP source: only inventory + agent readiness matter here; login
// and mutations are covered in the source-level suite.
class FakeOmpSource implements ArcAccountSource {
  readonly kind = "omp" as const;
  accounts: ArcAccount[];
  fail: Error | null = null;

  constructor(accounts: ArcAccount[]) {
    this.accounts = accounts;
  }

  async listAccounts(): Promise<ArcAccount[]> {
    if (this.fail !== null) throw this.fail;
    return this.accounts;
  }

  async getAccount(sourceId: string): Promise<ArcAccount> {
    const found = this.accounts.find((entry) => entry.sourceId === sourceId);
    if (found === undefined) {
      throw new Error(`account-not-found: ${sourceId}`);
    }
    return found;
  }

  async setAccountEnabled(): Promise<ArcAccount> {
    throw new Error("not used");
  }

  async removeAccount(): Promise<void> {
    throw new Error("not used");
  }

  async setAccountPriority(): Promise<ArcAccount> {
    throw new Error("not used");
  }

  async reorderAccounts(): Promise<void> {
    throw new Error("not used");
  }

  async startOpenAiLogin(): Promise<never> {
    throw new Error("not used");
  }

  async pollOpenAiLogin(): Promise<never> {
    throw new Error("not used");
  }

  async cancelOpenAiLogin(): Promise<void> {
    throw new Error("not used");
  }

  async startClaudeLogin(): Promise<never> {
    throw new Error("not used");
  }

  async completeClaudeLogin(): Promise<never> {
    throw new Error("not used");
  }
}

async function statusFor(
  fixture: Fixture,
  ompAccounts: ArcAccount[],
  options: { ompFail?: Error | null } = {},
): Promise<ArcAgentStatus> {
  const omp = new FakeOmpSource(ompAccounts);
  omp.fail = options.ompFail ?? null;
  const source = new ServiceArcAccountStatusSource(
    new ArcAccountService({ sources: [omp] }),
  );
  const manager = new ArcAgentManager({
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
    runtimePaths: fixture.paths,
    accountStatusSource: source,
  });
  return manager.getArcAgent("omp");
}

function connectAccountAction(status: ArcAgentStatus) {
  const action = status.actions.find((entry) => entry.id === "connect-account");
  if (action === undefined) throw new Error("connect-account action missing");
  return action;
}

describe("ArcAgentManager OMP account integration", () => {
  it("the Arc agent catalog stays exactly OMP, Codex, Claude Code", () => {
    expect(ARC_AGENT_CATALOG.map((entry) => entry.id)).toEqual([
      "omp",
      "codex",
      "claude-code",
    ]);
    // OMP providers (Kimi, Gemini, ...) must never become Arc agents.
    const ids = ARC_AGENT_CATALOG.map((entry) => entry.id).join(" ");
    expect(ids).not.toContain("kimi");
    expect(ids).not.toContain("gemini");
    expect(ids).not.toContain("openrouter");
  });

  it("OMP ready with zero accounts is account-required with connect-account available", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "omp");
    const status = await statusFor(fixture, []);
    expect(status.runtime.state).toBe("ready");
    expect(status.account.state).toBe("not-connected");
    expect(status.overallState).toBe("account-required");
    expect(connectAccountAction(status)).toMatchObject({ available: true });
  });

  it("OMP ready with a connected account is ready", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "omp");
    const status = await statusFor(fixture, [ompAccount()]);
    expect(status.account.state).toBe("connected");
    expect(status.overallState).toBe("ready");
    expect(connectAccountAction(status).available).toBe(false);
  });

  it("a disconnected account still means account-required", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "omp");
    const status = await statusFor(
      fixture,
      [ompAccount({ authState: "disabled" })],
    );
    expect(status.account.state).toBe("not-connected");
    expect(status.overallState).toBe("account-required");
  });

  it("an unreadable OMP account source stays unknown and conservative", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "omp");
    const status = await statusFor(fixture, [ompAccount()], {
      ompFail: new Error("omp broker down"),
    });
    expect(status.account.state).toBe("unknown");
    const expected: ArcAgentOverallState = "runtime-ready";
    expect(status.overallState).toBe(expected);
    expect(connectAccountAction(status)).toMatchObject({
      available: false,
      reason: "account state is unknown",
    });
  });

  it("runtime problems still dominate OMP overall state", async () => {
    const fixture = await makeFixture();
    // OMP runtime never activated.
    const status = await statusFor(fixture, [ompAccount()]);
    expect(status.runtime.state).toBe("not-prepared");
    expect(status.overallState).toBe("not-prepared");
    expect(connectAccountAction(status).available).toBe(false);
  });

  it("status reads are side-effect free on the manifest", async () => {
    const fixture = await makeFixture();
    await activateRuntime(fixture, "omp");
    const before = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: fixture.paths.manifestPath,
      platform: PLATFORM,
    });
    await statusFor(fixture, [ompAccount()]);
    await statusFor(fixture, []);
    const after = await readArcRuntimeManifest({
      createdByArcVersion: CREATED_BY,
      manifestPath: fixture.paths.manifestPath,
      platform: PLATFORM,
    });
    expect(after).toEqual(before);
  });
});
