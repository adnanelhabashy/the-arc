import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { stageReleaseExecutable } from "../src/arc-runtime/acquire.js";
import { sha256File } from "../src/arc-runtime/digest.js";
import { probeArcRuntimeVersion } from "../src/arc-runtime/probe.js";
import type { ArcRuntimeRelease } from "../src/arc-runtime/releases.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-acquire-test-"));
  tempDirs.push(dir);
  return dir;
}

async function tarCreate(
  archivePath: string,
  workingDir: string,
  entries: string[],
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      "tar",
      ["-czf", archivePath, ...entries],
      { cwd: workingDir },
      (error) => {
        if (error !== null) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      },
    );
  });
}

function makeTarWithEntry(entryName: string): Buffer {
  const content = Buffer.from("#!/bin/sh\necho codex-cli 0.155.1\n", "utf8");
  const paddedLength = Math.ceil(content.length / 512) * 512;
  const header = Buffer.alloc(512);
  header.write(entryName, 0, "utf8");
  header.write("0000755", 100, "utf8");
  header.write("0000000", 108, "utf8");
  header.write("0000000", 116, "utf8");
  header.write(content.length.toString(8).padStart(11, "0"), 124, "utf8");
  header.write("00000000000", 136, "utf8");
  header.fill(" ", 148, 156);
  header.write("00", 156, "utf8");
  header.write("ustar", 257, "utf8");
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  const body = Buffer.alloc(paddedLength);
  content.copy(body);
  return Buffer.concat([header, body, Buffer.alloc(1024)]);
}

const FAKE_VERSION = "0.155.1";

async function fakeCodexScript(dir: string, version: string): Promise<string> {
  const scriptPath = join(dir, "codex-aarch64-apple-darwin");
  await writeFile(
    scriptPath,
    `#!/bin/sh\necho "codex-cli ${version}"\n`,
    "utf8",
  );
  await chmod(scriptPath, 0o644);
  return scriptPath;
}

async function buildArchive(opts: {
  version?: string;
  extraEntry?: string;
  entryName?: string;
}): Promise<{ archivePath: string; digest: string }> {
  const dir = await tempDir();
  const entryName = opts.entryName ?? "codex-aarch64-apple-darwin";
  const scriptPath = await fakeCodexScript(
    dir,
    opts.version ?? FAKE_VERSION,
  );
  await rm(scriptPath);
  await writeFile(
    join(dir, entryName),
    `#!/bin/sh\necho "codex-cli ${opts.version ?? FAKE_VERSION}"\n`,
    "utf8",
  );
  if (opts.extraEntry !== undefined) {
    await writeFile(join(dir, opts.extraEntry), "junk", "utf8");
  }
  const archivePath = join(dir, "fixture.tar.gz");
  await tarCreate(archivePath, dir, [
    entryName,
    ...(opts.extraEntry !== undefined ? [opts.extraEntry] : []),
  ]);
  return { archivePath, digest: await sha256File(archivePath) };
}

async function releaseFor(
  executablePath: string,
  overrides: Partial<ArcRuntimeRelease> = {},
): Promise<ArcRuntimeRelease> {
  return {
    runtimeId: "codex",
    artifactKind: "archive",
    version: FAKE_VERSION,
    platform: "darwin-arm64",
    releaseTag: "rust-v0.155.1",
    assetName: "codex-aarch64-apple-darwin.tar.gz",
    downloadUrl:
      "https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-aarch64-apple-darwin.tar.gz",
    sha256: "0".repeat(64),
    executableSha256: await sha256File(executablePath),
    expectedExecutableVersion: FAKE_VERSION,
    license: "Apache-2.0",
    ...overrides,
  };
}

async function stagedRelease(opts: {
  version?: string;
  extraEntry?: string;
  entryName?: string;
  overrides?: Partial<ArcRuntimeRelease>;
}) {
  const dir = await tempDir();
  const scriptDir = await tempDir();
  const scriptPath = await fakeCodexScript(
    scriptDir,
    opts.version ?? FAKE_VERSION,
  );
  const release = await releaseFor(scriptPath, opts.overrides);
  const { archivePath } = await buildArchive(opts);
  const stagingDir = join(dir, "staging");
  const result = await stageReleaseExecutable({
    assetPath: archivePath,
    release,
    stagingDir,
  });
  return { result, stagingDir, release };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("stageReleaseExecutable", () => {
  it("accepts a correct archive and stages a verified executable", async () => {
    const { result, stagingDir } = await stagedRelease({});
    if (result.kind !== "ok") {
      throw new Error(`expected ok, got ${result.reason}`);
    }
    expect(result.version).toBe(FAKE_VERSION);
    expect(result.executablePath).toBe(join(stagingDir, "codex"));
    const probed = await probeArcRuntimeVersion({
      executablePath: result.executablePath,
    });
    expect(probed).toEqual({ kind: "ok", version: FAKE_VERSION });
  });

  it("rejects an archive whose executable digest differs from the pin", async () => {
    const { result } = await stagedRelease({
      overrides: { executableSha256: "1".repeat(64) },
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("digest mismatch");
    }
  });

  it("rejects an archive with more than one entry", async () => {
    const { result } = await stagedRelease({ extraEntry: "extra.txt" });
    expect(result.kind).toBe("rejected");
  });

  it("rejects an archive whose entry name does not match the expected executable", async () => {
    const { result } = await stagedRelease({ entryName: "surprise.bin" });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("does not match expected executable name");
    }
  });

  it("rejects an archive with a path-traversal entry", async () => {
    const dir = await tempDir();
    const scriptDir = await tempDir();
    const scriptPath = await fakeCodexScript(scriptDir, FAKE_VERSION);
    const release = await releaseFor(scriptPath);

    const archivePath = join(dir, "traversal.tar.gz");
    await writeFile(archivePath, gzipSync(makeTarWithEntry("../evil")), "utf8");
    const result = await stageReleaseExecutable({
      assetPath: archivePath,
      release,
      stagingDir: join(dir, "staging"),
    });
    expect(result.kind).toBe("rejected");
  });

  it("rejects an archive whose executable reports the wrong version", async () => {
    const { result } = await stagedRelease({ version: "0.99.9" });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("0.99.9");
    }
  });

  it("corrects a non-executable archive member to executable permissions", async () => {
    const { result } = await stagedRelease({});
    if (result.kind !== "ok") {
      throw new Error(`expected ok, got ${result.reason}`);
    }
    await expect(
      access(result.executablePath, constants.X_OK),
    ).resolves.toBeUndefined();
  });

  it("rejects a non-archive file", async () => {
    const dir = await tempDir();
    const notArchive = join(dir, "not-a.tar.gz");
    await writeFile(notArchive, "this is not gzip data", "utf8");
    const scriptDir = await tempDir();
    const scriptPath = await fakeCodexScript(scriptDir, FAKE_VERSION);
    const release = await releaseFor(scriptPath);
    const result = await stageReleaseExecutable({
      assetPath: notArchive,
      release,
      stagingDir: join(dir, "staging"),
    });
    expect(result.kind).toBe("rejected");
  });
});

const OMP_FAKE_VERSION = "18.2.6";

async function fakeOmpBinary(
  dir: string,
  version: string,
): Promise<string> {
  const binaryPath = join(dir, "omp-darwin-arm64");
  await writeFile(
    binaryPath,
    `#!/bin/sh\necho "omp/${version}"\n`,
    "utf8",
  );
  await chmod(binaryPath, 0o644);
  return binaryPath;
}

async function ompReleaseFor(
  assetPath: string,
  overrides: Partial<ArcRuntimeRelease> = {},
): Promise<ArcRuntimeRelease> {
  const digest = await sha256File(assetPath);
  return {
    runtimeId: "omp",
    artifactKind: "executable",
    version: OMP_FAKE_VERSION,
    platform: "darwin-arm64",
    releaseTag: "v18.2.6",
    assetName: "omp-darwin-arm64",
    downloadUrl:
      "https://github.com/can1357/oh-my-pi/releases/download/v18.2.6/omp-darwin-arm64",
    sha256: digest,
    executableSha256: digest,
    expectedExecutableVersion: OMP_FAKE_VERSION,
    license: "MIT",
    ...overrides,
  };
}

describe("stageReleaseExecutable — direct executable artifacts", () => {
  it("stages a verified executable from a direct binary asset", async () => {
    const assetDir = await tempDir();
    const assetPath = await fakeOmpBinary(assetDir, OMP_FAKE_VERSION);
    const release = await ompReleaseFor(assetPath);
    const stagingDir = join(await tempDir(), "staging");

    const result = await stageReleaseExecutable({
      assetPath,
      release,
      stagingDir,
    });

    if (result.kind !== "ok") {
      throw new Error(`expected ok, got ${result.reason}`);
    }
    expect(result.version).toBe(OMP_FAKE_VERSION);
    expect(result.executablePath).toBe(join(stagingDir, "omp"));
    await expect(
      access(result.executablePath, constants.X_OK),
    ).resolves.toBeUndefined();
  });

  it("rejects a direct binary whose digest differs from the pin", async () => {
    const assetDir = await tempDir();
    const assetPath = await fakeOmpBinary(assetDir, OMP_FAKE_VERSION);
    const release = await ompReleaseFor(assetPath, {
      sha256: "1".repeat(64),
    });
    const result = await stageReleaseExecutable({
      assetPath,
      release,
      stagingDir: join(await tempDir(), "staging"),
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("digest mismatch");
    }
  });

  it("rejects a direct binary reporting the wrong version", async () => {
    const assetDir = await tempDir();
    const assetPath = await fakeOmpBinary(assetDir, "18.3.0");
    const release = await ompReleaseFor(assetPath);
    const result = await stageReleaseExecutable({
      assetPath,
      release,
      stagingDir: join(await tempDir(), "staging"),
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("18.3.0");
    }
  });

  it("rejects a direct binary asset that is not a regular file", async () => {
    const assetDir = await tempDir();
    const binaryPath = await fakeOmpBinary(assetDir, OMP_FAKE_VERSION);
    const release = await ompReleaseFor(binaryPath);
    const result = await stageReleaseExecutable({
      assetPath: assetDir,
      release,
      stagingDir: join(await tempDir(), "staging"),
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("not a regular file");
    }
  });
});
