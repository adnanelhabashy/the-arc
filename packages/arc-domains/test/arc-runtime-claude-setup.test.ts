import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareManagedClaudeCode } from "../src/arc-runtime/claude-setup.js";
import { sha256File } from "../src/arc-runtime/digest.js";
import {
  createEmptyArcRuntimeManifest,
  readArcRuntimeManifest,
  writeArcRuntimeManifest,
  type ArcRuntimeManifest,
} from "../src/arc-runtime/manifest.js";
import {
  createArcRuntimePaths,
  type ArcRuntimePaths,
} from "../src/arc-runtime/paths.js";
import type { ArcRuntimeRelease } from "../src/arc-runtime/releases.js";
import type { ArcRuntimeSource } from "../src/arc-runtime/types.js";

const VERSION = "2.1.276";
const PLATFORM = "darwin-arm64";
const CREATED_BY = "0.43.1";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-claude-setup-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Fixture {
  userDataPath: string;
  paths: ArcRuntimePaths;
  release: ArcRuntimeRelease;
  stagedBinaryPath: string;
}

async function makeFixture(
  binaryVersion: string = VERSION,
): Promise<Fixture> {
  const root = await tempDir();
  const userDataPath = join(root, "userData");
  const sourceDir = await tempDir();
  const stagedBinaryPath = join(sourceDir, "claude");
  await writeFile(
    stagedBinaryPath,
    `#!/bin/sh\necho "${binaryVersion} (Claude Code)"\n`,
    "utf8",
  );
  await chmod(stagedBinaryPath, 0o755);
  const digest = await sha256File(stagedBinaryPath);
  const release: ArcRuntimeRelease = {
    runtimeId: "claude-code",
    artifactKind: "direct-official",
    version: VERSION,
    platform: PLATFORM,
    releaseTag: "v2.1.276",
    assetName: "claude",
    downloadUrl:
      "https://downloads.claude.ai/claude-code-releases/2.1.276/darwin-arm64/claude",
    sha256: digest,
    executableSha256: digest,
    expectedExecutableVersion: VERSION,
    license: "Anthropic Commercial Terms",
  };
  return {
    userDataPath,
    paths: createArcRuntimePaths({ userDataPath }),
    release,
    stagedBinaryPath,
  };
}

function setupArgs(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof prepareManagedClaudeCode>[0]> = {},
) {
  return {
    createdByArcVersion: CREATED_BY,
    download: async (_url: string, destinationPath: string) => {
      await copyFile(fixture.stagedBinaryPath, destinationPath);
    },
    platform: PLATFORM,
    release: fixture.release,
    runDoctor: async () =>
      "Running: native (2.1.276)\nNo installation issues found.",
    runtimePaths: fixture.paths,
    verifyCodeSignature: async () => true,
    ...overrides,
  };
}

async function readManifest(fixture: Fixture): Promise<ArcRuntimeManifest> {
  const result = await readArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    manifestPath: fixture.paths.manifestPath,
    platform: PLATFORM,
  });
  if (result.kind === "unsupported-version") {
    throw new Error("unexpected unsupported-version manifest");
  }
  return result.manifest;
}

async function writeActiveClaude(
  fixture: Fixture,
  version: string,
  opts: { runnable?: boolean; source?: ArcRuntimeSource } = {},
): Promise<void> {
  const manifest = createEmptyArcRuntimeManifest({
    createdByArcVersion: CREATED_BY,
    platform: PLATFORM,
  });
  manifest.runtimes["claude-code"] = {
    activeVersion: version,
    previousVersion: null,
    knownGoodVersion: version,
    source: opts.source ?? "official-managed-install",
    digest: "0".repeat(64),
    componentsByVersion: {},
    installedAt: Date.now(),
  };
  await writeArcRuntimeManifest({
    manifest,
    manifestPath: fixture.paths.manifestPath,
  });
  if (opts.runnable !== false) {
    const executablePath = fixture.paths.executablePath("claude-code", version);
    await mkdir(dirname(executablePath), { recursive: true });
    await writeFile(
      executablePath,
      `#!/bin/sh\necho "${version} (Claude Code)"\n`,
      "utf8",
    );
    await chmod(executablePath, 0o755);
  }
}

describe("prepareManagedClaudeCode", () => {
  it("A: clean environment installs, verifies, and activates the pinned Claude", async () => {
    const fixture = await makeFixture();
    const result = await prepareManagedClaudeCode(setupArgs(fixture));

    expect(result.state).toBe("ready");
    expect(result.executablePath).toBe(
      join(
        fixture.userDataPath,
        "arc-runtimes",
        "runtimes",
        "claude-code",
        VERSION,
        "claude",
      ),
    );

    const manifest = await readManifest(fixture);
    const entry = manifest.runtimes["claude-code"];
    expect(entry.activeVersion).toBe(VERSION);
    expect(entry.source).toBe("official-managed-install");
    expect(entry.digest).toBe(fixture.release.executableSha256);
    expect(entry.previousVersion).toBeNull();
  });

  it("B: download failure leaves the manifest unchanged and records backoff", async () => {
    const fixture = await makeFixture();
    const result = await prepareManagedClaudeCode(
      setupArgs(fixture, {
        download: async () => {
          throw new Error("network unreachable");
        },
      }),
    );

    expect(result.state).toBe("broken");
    expect(result.detail).toContain("network unreachable");
    const manifest = await readManifest(fixture);
    expect(manifest.runtimes["claude-code"].activeVersion).toBeNull();
    const backoffRaw = await readFile(
      join(fixture.userDataPath, "arc-runtimes", "claude-setup-state.json"),
      "utf8",
    );
    expect(JSON.parse(backoffRaw).consecutiveFailures).toBe(1);
  });

  it("C: checksum failure never activates", async () => {
    const fixture = await makeFixture();
    const tampered = {
      ...fixture.release,
      executableSha256: "1".repeat(64),
    };
    const result = await prepareManagedClaudeCode(
      setupArgs(fixture, { release: tampered }),
    );

    expect(result.state).toBe("broken");
    expect(result.detail).toContain("digest mismatch");
    const manifest = await readManifest(fixture);
    expect(manifest.runtimes["claude-code"].activeVersion).toBeNull();
  });

  it("D: code-signature failure never activates", async () => {
    const fixture = await makeFixture();
    const result = await prepareManagedClaudeCode(
      setupArgs(fixture, { verifyCodeSignature: async () => false }),
    );

    expect(result.state).toBe("broken");
    expect(result.detail).toContain("code-signature");
    const manifest = await readManifest(fixture);
    expect(manifest.runtimes["claude-code"].activeVersion).toBeNull();
  });

  it("E: wrong version probe never activates", async () => {
    const fixture = await makeFixture("2.1.280");
    const result = await prepareManagedClaudeCode(setupArgs(fixture));

    expect(result.state).toBe("broken");
    expect(result.detail).toContain("2.1.280");
    const manifest = await readManifest(fixture);
    expect(manifest.runtimes["claude-code"].activeVersion).toBeNull();
  });

  it("F: an existing external Claude is not touched", async () => {
    const fixture = await makeFixture();
    const externalLauncher = join(
      fixture.userDataPath,
      "..",
      "home",
      ".local",
      "bin",
      "claude",
    );
    await mkdir(dirname(externalLauncher), { recursive: true });
    await writeFile(externalLauncher, "#!/bin/sh\necho external\n", "utf8");
    await chmod(externalLauncher, 0o755);
    const before = await readFile(externalLauncher, "utf8");

    const result = await prepareManagedClaudeCode(setupArgs(fixture));

    expect(result.state).toBe("ready");
    await expect(readFile(externalLauncher, "utf8")).resolves.toBe(before);
  });

  it("G: a newer active managed Claude is kept, not downgraded", async () => {
    const fixture = await makeFixture();
    await writeActiveClaude(fixture, "2.1.280");

    let downloadCalled = false;
    const result = await prepareManagedClaudeCode(
      setupArgs(fixture, {
        download: async () => {
          downloadCalled = true;
          throw new Error("download must not be called");
        },
      }),
    );

    expect(result.state).toBe("ready");
    expect(result.detail).toContain("2.1.280");
    expect(downloadCalled).toBe(false);
    const manifest = await readManifest(fixture);
    expect(manifest.runtimes["claude-code"].activeVersion).toBe("2.1.280");
  });

  it("H: an already-ready managed Claude is idempotent and offline", async () => {
    const fixture = await makeFixture();
    await writeActiveClaude(fixture, VERSION);

    let downloadCalled = false;
    const result = await prepareManagedClaudeCode(
      setupArgs(fixture, {
        download: async () => {
          downloadCalled = true;
          throw new Error("download must not be called");
        },
      }),
    );

    expect(result.state).toBe("ready");
    expect(downloadCalled).toBe(false);
  });

  it("repairs a same-version managed Claude missing its executable", async () => {
    const fixture = await makeFixture();
    await writeActiveClaude(fixture, VERSION, { runnable: false });

    const result = await prepareManagedClaudeCode(setupArgs(fixture));

    expect(result.state).toBe("ready");
    expect(result.detail).toContain(VERSION);
    const manifest = await readManifest(fixture);
    expect(manifest.runtimes["claude-code"].activeVersion).toBe(VERSION);
    expect(manifest.runtimes["claude-code"].source).toBe(
      "official-managed-install",
    );
  });

  it("defers a broken different active version without replacing it", async () => {
    const fixture = await makeFixture();
    await writeActiveClaude(fixture, "2.1.280", { runnable: false });

    const result = await prepareManagedClaudeCode(setupArgs(fixture));

    expect(result.state).toBe("broken");
    expect(result.detail).toContain("deferred");
  });

  it("skips retrying while backoff is active, then retries after the delay", async () => {
    const fixture = await makeFixture();
    let now = 1_000_000;
    const failingDownload = async (): Promise<void> => {
      throw new Error("still offline");
    };

    const first = await prepareManagedClaudeCode(
      setupArgs(fixture, { download: failingDownload, now: () => now }),
    );
    expect(first.state).toBe("broken");

    now += 10_000;
    const second = await prepareManagedClaudeCode(
      setupArgs(fixture, { download: failingDownload, now: () => now }),
    );
    expect(second.state).toBe("not-installed");
    expect(second.detail).toContain("backoff");

    now += 120_000;
    const third = await prepareManagedClaudeCode(
      setupArgs(fixture, { download: failingDownload, now: () => now }),
    );
    expect(third.state).toBe("broken");
  });

  it("preserves a future manifest schema instead of overwriting it", async () => {
    const fixture = await makeFixture();
    await mkdir(dirname(fixture.paths.manifestPath), { recursive: true });
    await writeFile(
      fixture.paths.manifestPath,
      JSON.stringify({ schemaVersion: 99, note: "future" }),
      "utf8",
    );

    const result = await prepareManagedClaudeCode(setupArgs(fixture));

    expect(result.state).toBe("unsupported");
    await expect(readFile(fixture.paths.manifestPath, "utf8")).resolves.toBe(
      JSON.stringify({ schemaVersion: 99, note: "future" }),
    );
  });

  it("never stores anything but metadata in the manifest", async () => {
    const fixture = await makeFixture();
    await prepareManagedClaudeCode(setupArgs(fixture));

    const raw = JSON.parse(
      await readFile(fixture.paths.manifestPath, "utf8"),
    ) as Record<string, unknown>;
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toMatch(/token|secret|apikey|api_key|password/i);
    expect(Object.keys(raw.runtimes as Record<string, unknown>)).toEqual([
      "codex",
      "claude-code",
      "omp",
    ]);
  });
});
