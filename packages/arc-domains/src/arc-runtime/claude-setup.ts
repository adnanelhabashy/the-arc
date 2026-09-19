import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { sha256File } from "./digest.js";
import {
  mutateArcRuntimeManifest,
  readArcRuntimeManifest,
} from "./manifest.js";
import type { ArcRuntimePaths } from "./paths.js";
import { probeArcRuntimeVersion } from "./probe.js";
import {
  ARC_CLAUDE_CODE_RELEASE,
  validateArcRuntimeRelease,
  type ArcRuntimeRelease,
} from "./releases.js";

const CLAUDE_SETUP_STATE_FILE_NAME = "claude-setup-state.json";
const DOWNLOAD_TIMEOUT_MS = 600_000;
const SETUP_BACKOFF_DELAYS_MS = [
  60_000,
  300_000,
  1_800_000,
  21_600_000,
] as const;

export type ClaudeSetupState =
  | "not-installed"
  | "external"
  | "installing"
  | "verifying"
  | "ready"
  | "broken"
  | "unsupported";

export interface ClaudeSetupResult {
  state: ClaudeSetupState;
  detail: string;
  executablePath: string | null;
}

export interface PrepareManagedClaudeCodeArgs {
  createdByArcVersion: string;
  onDiagnostic?: (message: string) => void;
  platform: string;
  release?: ArcRuntimeRelease;
  runtimePaths: ArcRuntimePaths;
  // Test seams.
  download?: (url: string, destinationPath: string) => Promise<void>;
  runDoctor?: (executablePath: string) => Promise<string | null>;
  verifyCodeSignature?: (executablePath: string) => Promise<boolean>;
  now?: () => number;
}

interface ClaudeSetupBackoffState {
  consecutiveFailures: number;
  lastAttemptAt: number;
}

async function defaultDownload(
  url: string,
  destinationPath: string,
): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  const temporaryPath = `${destinationPath}.tmp-${process.pid}`;
  // Executor form: the desktop tsconfig lib predates Promise.withResolvers.
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const stream = Readable.fromWeb(
    response.body as Parameters<typeof Readable.fromWeb>[0],
  );
  const file = createWriteStream(temporaryPath, { flags: "wx" });
  stream.pipe(file);
  file.on("finish", () => {
    resolvePromise();
  });
  file.on("error", rejectPromise);
  stream.on("error", rejectPromise);
  await promise;
  await rename(temporaryPath, destinationPath);
}

async function defaultVerifyCodeSignature(
  executablePath: string,
): Promise<boolean> {
  const run = (args: string[]) =>
    new Promise<string>((resolvePromise, rejectPromise) => {
      execFile(
        "codesign",
        args,
        { timeout: 30_000, maxBuffer: 64 * 1024 },
        (error, _stdout, stderr) => {
          if (error !== null) {
            rejectPromise(new Error(String(stderr).slice(0, 200)));
            return;
          }
          resolvePromise(String(stderr));
        },
      );
    });

  try {
    await run(["--verify", "--verbose=4", executablePath]);
    const info = await run(["-dv", "--verbose=4", executablePath]);
    return info.includes("Anthropic");
  } catch {
    return false;
  }
}

async function defaultRunDoctor(
  executablePath: string,
): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(
      executablePath,
      ["doctor"],
      {
        timeout: 60_000,
        maxBuffer: 128 * 1024,
        env: { ...process.env, DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1" },
      },
      (error, stdout) => {
        if (error !== null) {
          resolvePromise(null);
          return;
        }
        resolvePromise(String(stdout));
      },
    );
  });
}

async function readBackoffState(
  statePath: string,
): Promise<ClaudeSetupBackoffState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { consecutiveFailures?: unknown }).consecutiveFailures ===
        "number" &&
      typeof (parsed as { lastAttemptAt?: unknown }).lastAttemptAt === "number"
    ) {
      return parsed as ClaudeSetupBackoffState;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeBackoffState(
  statePath: string,
  state: ClaudeSetupBackoffState,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, "utf8");
  await rename(temporaryPath, statePath);
}

async function isRunnableFile(path: string): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

function diagnose(
  args: PrepareManagedClaudeCodeArgs,
  message: string,
): void {
  args.onDiagnostic?.(`[arc-runtime] ${message}`);
}

export async function prepareManagedClaudeCode(
  args: PrepareManagedClaudeCodeArgs,
): Promise<ClaudeSetupResult> {
  const release = args.release ?? ARC_CLAUDE_CODE_RELEASE;
  const now = args.now ?? Date.now;
  const download = args.download ?? defaultDownload;
  const runDoctor = args.runDoctor ?? defaultRunDoctor;
  const verifyCodeSignature =
    args.verifyCodeSignature ?? defaultVerifyCodeSignature;
  const isDarwin = args.platform.startsWith("darwin");

  const validation = validateArcRuntimeRelease(release);
  if (validation.kind === "invalid") {
    return {
      state: "unsupported",
      detail: `invalid pinned Claude release metadata: ${validation.problem}`,
      executablePath: null,
    };
  }
  if (release.runtimeId !== "claude-code") {
    return {
      state: "unsupported",
      detail: "prepareManagedClaudeCode only manages the claude-code runtime",
      executablePath: null,
    };
  }

  const manifestPath = args.runtimePaths.manifestPath;
  const manifestResult = await readArcRuntimeManifest({
    createdByArcVersion: args.createdByArcVersion,
    manifestPath,
    platform: args.platform,
  });
  if (manifestResult.kind === "unsupported-version") {
    return {
      state: "unsupported",
      detail: `manifest declares unsupported schema version ${manifestResult.schemaVersion}; leaving untouched`,
      executablePath: null,
    };
  }
  const manifest = manifestResult.manifest;
  const entry = manifest.runtimes["claude-code"];

  if (entry.activeVersion !== null) {
    const activeExecutablePath = args.runtimePaths.executablePath(
      "claude-code",
      entry.activeVersion,
    );
    const activeRunnable = await isRunnableFile(activeExecutablePath);
    if (activeRunnable) {
      return {
        state: "ready",
        detail: `claude-code ${entry.activeVersion} already active; reusing verified copy`,
        executablePath: activeExecutablePath,
      };
    }
    if (entry.activeVersion !== release.version) {
      return {
        state: "broken",
        detail: `claude-code ${entry.activeVersion} is active but its executable is broken; recovery is deferred to the runtime repair/update flow`,
        executablePath: null,
      };
    }
    diagnose(
      args,
      `claude-code ${release.version} active in manifest but ${activeExecutablePath} is missing; reinstalling from Anthropic`,
    );
  }

  const statePath = join(
    dirname(args.runtimePaths.manifestPath),
    CLAUDE_SETUP_STATE_FILE_NAME,
  );
  const backoff = await readBackoffState(statePath);
  const attempts =
    backoff?.consecutiveFailures === undefined
      ? 0
      : backoff.consecutiveFailures;
  // Delay after n recorded failures is delays[n-1]: the first retry waits the
  // shortest delay.
  const delay =
    SETUP_BACKOFF_DELAYS_MS[
      Math.max(0, Math.min(attempts - 1, SETUP_BACKOFF_DELAYS_MS.length - 1))
    ];
  if (
    entry.activeVersion === null &&
    backoff !== null &&
    now() - backoff.lastAttemptAt < delay
  ) {
    return {
      state: "not-installed",
      detail: `claude setup skipped: last attempt failed ${Math.round(
        (now() - backoff.lastAttemptAt) / 1000,
      )}s ago; retrying after backoff`,
      executablePath: null,
    };
  }

  const stagingRoot = args.runtimePaths.stagingRoot;
  await mkdir(stagingRoot, { recursive: true });
  const stagingDir = join(
    stagingRoot,
    `claude-code-${release.version}-${process.pid}`,
  );
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const recordFailure = async (detail: string): Promise<ClaudeSetupResult> => {
    await writeBackoffState(statePath, {
      consecutiveFailures: attempts + 1,
      lastAttemptAt: now(),
    }).catch(() => undefined);
    return { state: "broken", detail, executablePath: null };
  };

  try {
    const stagedExecutable = join(stagingDir, "claude");
    await download(release.downloadUrl, stagedExecutable);

    const stagedDigest = await sha256File(stagedExecutable);
    if (stagedDigest !== release.executableSha256) {
      await rm(stagingDir, { recursive: true, force: true });
      return recordFailure(
        `downloaded Claude digest mismatch: expected ${release.executableSha256}, got ${stagedDigest}; not activating`,
      );
    }

    if (isDarwin) {
      const signatureOk = await verifyCodeSignature(stagedExecutable);
      if (!signatureOk) {
        await rm(stagingDir, { recursive: true, force: true });
        return recordFailure(
          "downloaded Claude failed macOS code-signature verification; not activating",
        );
      }
    }

    await chmod(stagedExecutable, 0o755);
    const probe = await probeArcRuntimeVersion({
      executablePath: stagedExecutable,
    });
    if (
      probe.kind === "failed" ||
      probe.version !== release.expectedExecutableVersion
    ) {
      await rm(stagingDir, { recursive: true, force: true });
      return recordFailure(
        probe.kind === "failed"
          ? `downloaded Claude version probe failed: ${probe.reason}`
          : `downloaded Claude reports ${probe.version}, expected ${release.expectedExecutableVersion}; not activating`,
      );
    }

    const doctorOutput = await runDoctor(stagedExecutable);
    if (doctorOutput === null) {
      diagnose(args, "claude doctor did not complete; continuing without it");
    } else {
      diagnose(
        args,
        `claude doctor: ${doctorOutput
          .split("\n")
          .filter(
            (line) =>
              line.includes("Running:") ||
              line.includes("No installation issues") ||
              line.includes("Auto-updates"),
          )
          .join(" | ")}`,
      );
    }

    const versionRoot = args.runtimePaths.versionRoot(
      "claude-code",
      release.version,
    );
    await mkdir(dirname(versionRoot), { recursive: true });
    await rm(versionRoot, { recursive: true, force: true });
    await rename(stagingDir, versionRoot);

    // Commit under the serialized manifest mutation: the manifest was read
    // before a multi-hundred-MB download, so a concurrent operation (e.g. a
    // Codex repair and this setup racing) may have changed it. Re-check
    // inside the lock and never clobber another operation's activation.
    const outcome: {
      current:
        | { kind: "activated"; executablePath: string }
        | { kind: "already-active"; executablePath: string }
        | { kind: "kept-existing"; executablePath: string };
    } = {
      current: {
        kind: "activated",
        executablePath: join(versionRoot, "claude"),
      },
    };
    await mutateArcRuntimeManifest({
      createdByArcVersion: args.createdByArcVersion,
      manifestPath,
      platform: args.platform,
      mutate: async (freshManifest) => {
        const freshEntry = freshManifest.runtimes["claude-code"];
        if (freshEntry.activeVersion !== null) {
          const freshExecutablePath = args.runtimePaths.executablePath(
            "claude-code",
            freshEntry.activeVersion,
          );
          if (await isRunnableFile(freshExecutablePath)) {
            outcome.current =
              freshEntry.activeVersion === release.version
                ? { kind: "already-active", executablePath: freshExecutablePath }
                : { kind: "kept-existing", executablePath: freshExecutablePath };
            return freshManifest;
          }
        }
        return {
          ...freshManifest,
          runtimes: {
            ...freshManifest.runtimes,
            "claude-code": {
              activeVersion: release.version,
              previousVersion: freshEntry.activeVersion,
              source: "official-managed-install",
              digest: stagedDigest,
              installedAt: now(),
            },
          },
        };
      },
    });
    await rm(statePath, { force: true });

    if (outcome.current.kind === "already-active") {
      return {
        state: "ready",
        detail: `claude-code ${release.version} already active; reusing verified copy`,
        executablePath: outcome.current.executablePath,
      };
    }
    if (outcome.current.kind === "kept-existing") {
      return {
        state: "ready",
        detail: `claude-code already active from another operation; reusing verified copy`,
        executablePath: outcome.current.executablePath,
      };
    }
    return {
      state: "ready",
      detail: `claude-code ${release.version} installed from Anthropic official distribution (digest ${stagedDigest})`,
      executablePath: outcome.current.executablePath,
    };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message : String(error);
    return recordFailure(`claude setup failed: ${detail}`);
  }
}
