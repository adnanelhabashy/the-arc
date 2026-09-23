import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseCodexEnabledFeatures,
  parseCodexModelCatalog,
  probeArcRuntimeHealth,
} from "../src/arc-runtime/health.js";
import { ARC_CODEX_RELEASE } from "../src/arc-runtime/releases.js";

/**
 * Proves the property the launch path depends on, against the real pinned
 * binary and the real staged helper: Arc's managed Codex needs no user
 * profile, no user catalog cache and no global Codex install for Code Mode.
 *
 * Every case runs in a disposable layout holding hardlinks to the two staged
 * artifacts — a hardlink is a real directory entry, so Codex's
 * sibling-of-executable host lookup still resolves inside the disposable
 * directory, and nothing is copied or downloaded. Skipped when the seeds are
 * absent, which is the case in a checkout that has not run the seed pipeline.
 *
 * No wall-clock waits: each case resolves on a real signal — a process exit, a
 * JSON event line, or the app-server's own `initialize` response — so a
 * failure points at the missing signal rather than at a guessed duration.
 */

/**
 * The staged artifacts the desktop seed pipeline writes
 * (`apps/desktop/scripts/prepare-arc-runtimes.mts`), located by walking up to
 * the workspace root rather than trusting `process.cwd()`, which is the package
 * directory under vitest. Absent in a checkout that has never run the pipeline,
 * which skips this file rather than failing it.
 */
function findSeedRoot(): string {
  let directory = process.cwd();
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      return join(directory, "apps", "desktop", "resources", "arc-runtimes");
    }
    const parent = resolve(directory, "..");
    if (parent === directory) {
      return join(process.cwd(), "resources", "arc-runtimes");
    }
    directory = parent;
  }
}

const seedRoot = findSeedRoot();
const seedVersionRoot = join(seedRoot, "codex", ARC_CODEX_RELEASE.version);
const codexSeedPath = join(seedVersionRoot, "codex");
const companionFileName = ARC_CODEX_RELEASE.companions?.[0]?.fileName ?? "";
const companionSeedPath = join(seedVersionRoot, companionFileName);
const seedsAvailable =
  existsSync(codexSeedPath) &&
  companionFileName.length > 0 &&
  existsSync(companionSeedPath);

const TEST_TIMEOUT_MS = 180_000;

const tempDirs: string[] = [];
const liveChildren: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of liveChildren.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface DisposableLayout {
  /** Directory holding the managed `codex`, with or without its helper. */
  readonly runtimeDir: string;
  /** A directory that has never held a Codex profile. */
  readonly codexHome: string;
}

async function disposableLayout(args: {
  withCompanion: boolean;
}): Promise<DisposableLayout> {
  const root = await mkdtemp(join(tmpdir(), "arc-codex-code-mode-"));
  tempDirs.push(root);
  const runtimeDir = join(root, "runtime");
  const codexHome = join(root, "codex-home");
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await link(codexSeedPath, join(runtimeDir, "codex"));
  if (args.withCompanion) {
    await link(companionSeedPath, join(runtimeDir, companionFileName));
  }
  return { runtimeDir, codexHome };
}

/**
 * The environment every case runs under: a fresh home, a fresh `CODEX_HOME`,
 * and a PATH with no Codex on it. `env -i` semantics are reproduced by passing
 * an explicit environment rather than inheriting this process's.
 */
function freshEnv(layout: DisposableLayout): NodeJS.ProcessEnv {
  return {
    HOME: layout.codexHome,
    CODEX_HOME: layout.codexHome,
    PATH: "/usr/bin:/bin",
  };
}

interface ChildRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawns a disposable managed Codex and collects its output until it exits or
 * `stopOnLine` matches a stdout line, whichever comes first. */
function runCodex(args: {
  executablePath: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stopOnLine?: (line: string) => boolean;
}): Promise<ChildRun> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(args.executablePath, [...args.argv], {
      env: args.env,
      cwd: args.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolvePromise({ code, stdout, stderr });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const stop = args.stopOnLine;
      if (stop === undefined) return;
      if (stdout.split("\n").some((line) => line.length > 0 && stop(line))) {
        finish(null);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      finish(code);
    });
  });
}

function jsonLines(stdout: string): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  return events;
}

const CODE_MODE_UNAVAILABLE = "Code Mode is unavailable";

function modelsArgs(layout: DisposableLayout): Parameters<typeof runCodex>[0] {
  return {
    executablePath: join(layout.runtimeDir, "codex"),
    argv: ["debug", "models"],
    env: freshEnv(layout),
    cwd: layout.runtimeDir,
  };
}

/** The Code-Mode model the disposable run is driven with, taken from the
 * binary's own catalog rather than hard-coded, so the case cannot silently
 * stop exercising a Code-Mode model when Codex renames its models. */
async function codeModeModelSlug(layout: DisposableLayout): Promise<string> {
  const models = await runCodex(modelsArgs(layout));
  const catalog = parseCodexModelCatalog(models.stdout);
  if (catalog === null) throw new Error("the managed Codex rendered no catalog");
  const model = catalog.find((entry) => entry.codeModeOnly);
  if (model === undefined) {
    throw new Error("the managed Codex rendered no Code-Mode model");
  }
  return model.slug;
}

/** Spawns the app-server and resolves with the response to request `id`. */
function initializeAppServer(args: {
  executablePath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): {
  readonly response: Promise<Record<string, unknown>>;
  readonly closed: Promise<number | null>;
  readonly child: ChildProcessWithoutNullStreams;
} {
  const child = spawn(
    args.executablePath,
    ["app-server", "-c", "check_for_update_on_startup=false"],
    { env: args.env, cwd: args.cwd, stdio: ["pipe", "pipe", "pipe"] },
  );
  liveChildren.push(child);
  const closed = new Promise<number | null>((resolvePromise) => {
    child.on("close", (code) => resolvePromise(code));
  });
  const response = new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof parsed !== "object" || parsed === null) continue;
        const record = parsed as Record<string, unknown>;
        if (record.id === 1) resolvePromise(record);
      }
    });
    child.on("error", rejectPromise);
    closed.then(() => {
      rejectPromise(new Error("the app-server exited before answering initialize"));
    });
  });
  child.stdin.write(
    `${JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "bb", version: "1.0.0", title: null },
        capabilities: { experimentalApi: true },
      },
    })}\n`,
  );
  return { response, closed, child };
}

describe.skipIf(!seedsAvailable)(
  "managed Codex Code Mode on a fresh profile",
  () => {
    it(
      "renders its own model catalog with an empty CODEX_HOME and no Codex on PATH",
      async () => {
        const layout = await disposableLayout({ withCompanion: true });

        const models = await runCodex(modelsArgs(layout));

        expect(models.code).toBe(0);
        const catalog = parseCodexModelCatalog(models.stdout);
        expect(catalog).not.toBeNull();
        // Rendered from the managed binary, not the user's catalog cache,
        // which does not exist in this layout.
        expect(catalog!.length).toBeGreaterThan(0);
        expect(catalog!.some((entry) => entry.codeModeOnly)).toBe(true);
        expect(existsSync(join(layout.codexHome, "models_cache.json"))).toBe(
          false,
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "reports code_mode_host enabled with an empty CODEX_HOME",
      async () => {
        const layout = await disposableLayout({ withCompanion: true });

        const doctor = await runCodex({
          executablePath: join(layout.runtimeDir, "codex"),
          argv: ["doctor", "--json"],
          env: freshEnv(layout),
          cwd: layout.runtimeDir,
        });

        // A fresh profile legitimately fails `auth.credentials`, so doctor
        // exits non-zero; the report is the evidence, not the exit code.
        expect(doctor.code).toBe(1);
        const features = parseCodexEnabledFeatures(doctor.stdout);
        expect(features).not.toBeNull();
        expect(features!).toContain("code_mode_host");
        // The runtime probe must read this as a healthy *runtime*, since being
        // signed out is an account concern rather than a runtime defect.
        const health = await probeArcRuntimeHealth({
          runtimeId: "codex",
          executablePath: join(layout.runtimeDir, "codex"),
          expectedVersion: ARC_CODEX_RELEASE.expectedExecutableVersion,
          components: ARC_CODEX_RELEASE.companions?.map((companion) => ({
            fileName: companion.fileName,
            expectedDigest: companion.executableSha256,
            livenessArgs: companion.livenessArgs,
          })),
          componentPath: (fileName) => join(layout.runtimeDir, fileName),
        });
        expect(health).toMatchObject({ kind: "healthy" });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "starts the app-server and answers the initialize handshake with an empty CODEX_HOME",
      async () => {
        const layout = await disposableLayout({ withCompanion: true });
        const server = initializeAppServer({
          executablePath: join(layout.runtimeDir, "codex"),
          env: freshEnv(layout),
          cwd: layout.runtimeDir,
        });

        const response = await server.response;
        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();

        // Closing stdin is the app-server's shutdown signal; a clean exit also
        // proves the process above was the server waiting for input.
        server.child.stdin.end();
        expect(await server.closed).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "does not report Code Mode unavailable for a Code-Mode model when the helper is a sibling",
      async () => {
        const layout = await disposableLayout({ withCompanion: true });
        const model = await codeModeModelSlug(layout);

        const run = await runCodex({
          executablePath: join(layout.runtimeDir, "codex"),
          argv: ["exec", "--skip-git-repo-check", "-m", model, "--json", "hi"],
          env: freshEnv(layout),
          cwd: layout.runtimeDir,
          stopOnLine: (line) =>
            line.includes("turn.started") || line.includes(CODE_MODE_UNAVAILABLE),
        });

        const events = jsonLines(run.stdout);
        expect(events.some((event) => event.type === "turn.started")).toBe(true);
        expect(run.stdout).not.toContain(CODE_MODE_UNAVAILABLE);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "reports Code Mode unavailable for the same model when the helper is absent",
      async () => {
        const withCompanion = await disposableLayout({ withCompanion: true });
        const model = await codeModeModelSlug(withCompanion);
        const layout = await disposableLayout({ withCompanion: false });

        const run = await runCodex({
          executablePath: join(layout.runtimeDir, "codex"),
          argv: ["exec", "--skip-git-repo-check", "-m", model, "--json", "hi"],
          env: freshEnv(layout),
          cwd: layout.runtimeDir,
          stopOnLine: (line) =>
            line.includes("turn.started") || line.includes(CODE_MODE_UNAVAILABLE),
        });

        expect(run.stdout).toContain(CODE_MODE_UNAVAILABLE);
        // Codex looked for the helper beside the executable it was launched
        // from — the disposable directory — not on PATH and not in ~/.codex.
        expect(run.stdout).toContain(join(layout.runtimeDir, companionFileName));
      },
      TEST_TIMEOUT_MS,
    );
  },
);
