import { execFile, spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { checkArcRuntimeComponents } from "./components.js";
import { probeArcRuntimeVersion } from "./probe.js";
import type { ArcRuntimeId } from "./types.js";

export type ArcRuntimeHealthProbeResult =
  | { kind: "healthy"; detail: string }
  | { kind: "unhealthy"; detail: string };

export interface ArcRuntimeHealthComponent {
  fileName: string;
  /** Digest the companion must have; null when nothing was recorded. */
  expectedDigest: string | null;
  /**
   * The argument vector that proves the companion starts. Omitted for a
   * companion with no meaningful offline liveness check, in which case
   * presence, executability and digest are the whole proof.
   */
  livenessArgs?: readonly string[];
}

export interface ProbeArcRuntimeHealthArgs {
  runtimeId: ArcRuntimeId;
  executablePath: string;
  expectedVersion: string;
  timeoutMs?: number;
  /**
   * Required companions of this version. Present means "check them": a
   * runtime whose helper is missing, non-executable, or the wrong bytes is
   * unhealthy even when the main binary is perfect, because the session it
   * would start cannot do what it is for.
   */
  components?: readonly ArcRuntimeHealthComponent[];
  componentPath?: (fileName: string) => string;
  // Test seams: real spawns are exercised by the *-real-binary suites; unit
  // tests inject fakes to cover the decision logic without a real
  // Codex/OMP/Claude binary on disk.
  runProcess?: (
    executablePath: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<{ stdout: string; ok: boolean }>;
  runAcpHandshake?: (
    executablePath: string,
    timeoutMs: number,
  ) => Promise<{ ok: boolean; detail: string }>;
  runLivenessProbe?: (
    executablePath: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<{ ok: boolean; detail: string }>;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const COMPANION_LIVENESS_WINDOW_MS = 1_500;

function defaultRunProcess(
  executablePath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; ok: boolean }> {
  return new Promise((resolvePromise) => {
    execFile(
      executablePath,
      args,
      {
        timeout: timeoutMs,
        // 256 KiB — `execFile`'s default — is too small for `debug models`:
        // the real 0.155.1 catalog is ~433 KiB, because each entry carries its
        // base instructions and message templates. A buffer that small turns a
        // healthy runtime into "could not render its own model catalog".
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => {
        resolvePromise({ stdout: String(stdout), ok: error === null });
      },
    );
  });
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
}

/**
 * Proves a companion starts and *stays* up on its stdio transport.
 *
 * `codex-code-mode-host --listen stdio` has no handshake to answer and no
 * `--version` flag, so the meaningful offline signal is that it accepts the
 * transport and does not exit: verified against the real 0.155.1 helper, which
 * exits 0 immediately when stdin is closed and stays alive (silently) when it
 * is held open. Anything else — a missing dynamic library, a truncated copy, a
 * mismatched architecture — dies inside the window.
 */
export function defaultRunStdioLivenessProbe(
  executablePath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolvePromise) => {
    const window = Math.min(timeoutMs, COMPANION_LIVENESS_WINDOW_MS);
    const child = spawn(executablePath, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp/arc-runtime-health-home" },
    });

    let settled = false;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const settle = (result: { ok: boolean; detail: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminate(child);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      settle({
        ok: true,
        detail: `${executablePath} accepted its stdio transport and stayed up`,
      });
    }, window);

    child.once("error", (error) => {
      settle({
        ok: false,
        detail: `${executablePath} failed to start: ${error.message}`,
      });
    });
    child.once("exit", (code, signal) => {
      settle({
        ok: false,
        detail: `${executablePath} exited instead of serving stdio (code ${String(code)}, signal ${String(signal)})${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ""}`,
      });
    });
  });
}

// A real (but account-free, offline) ACP `initialize` handshake — the same
// proof Phase 4 used live: OMP answers with protocolVersion/agentInfo before
// any credential is involved, so "ACP mode starts" is demonstrated rather
// than assumed from a bare `--help` exit code.
export function defaultRunOmpAcpHandshake(
  executablePath: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(executablePath, ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp/arc-runtime-health-home" },
    });

    let settled = false;
    const settle = (result: { ok: boolean; detail: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminate(child);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, detail: "omp acp did not respond in time" });
    }, timeoutMs);

    child.once("error", (error) => {
      settle({ ok: false, detail: `omp acp failed to start: ${error.message}` });
    });
    child.once("exit", (code, signal) => {
      settle({
        ok: false,
        detail: `omp acp exited before responding (code ${String(code)}, signal ${String(signal)})`,
      });
    });

    let buffered = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffered.slice(0, newlineIndex);
      try {
        const message = JSON.parse(line) as {
          result?: { protocolVersion?: unknown };
        };
        if (message.result?.protocolVersion !== undefined) {
          settle({ ok: true, detail: "acp initialize handshake answered" });
        }
      } catch {
        // Not a complete/valid JSON-RPC line yet; keep buffering.
      }
    });

    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1 },
      })}\n`,
    );
  });
}

const codexDoctorReportSchema = z.object({
  checks: z.object({
    "config.load": z.object({
      details: z.object({
        "enabled feature flags": z.string(),
      }),
    }),
  }),
});

/**
 * The effective feature set Codex reports for the invocation, from
 * `doctor --json`. This is the only supported way to see what Codex actually
 * resolved after `-c` overrides, config.toml and cloud-managed policy have all
 * been applied — verified against the real 0.155.1 binary, where
 * `-c features.code_mode_host=false doctor --json` drops `code_mode_host` from
 * this list and the default keeps it.
 *
 * Null means the report did not contain the field, which is a failure to
 * verify rather than a verified absence.
 */
export function parseCodexEnabledFeatures(
  doctorStdout: string,
): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(doctorStdout);
  } catch {
    return null;
  }
  const report = codexDoctorReportSchema.safeParse(parsed);
  if (!report.success) return null;
  return report.data.checks["config.load"].details["enabled feature flags"]
    .split(",")
    .map((flag) => flag.trim())
    .filter((flag) => flag.length > 0);
}

const codexModelCatalogSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string(),
      tool_mode: z.string().nullish(),
    }),
  ),
});

/**
 * The model catalog Codex renders for itself, from `codex debug models`.
 *
 * This is the live catalog reached through the managed runtime, not the user's
 * `models_cache.json`: it works on a completely empty `CODEX_HOME`, needs no
 * network and no account, and never writes the cache. Codex decides whether a
 * model uses Code Mode from the `tool_mode` recorded here, so a catalog this
 * binary cannot render is a Code Mode failure before any session starts.
 *
 * Null means the output was not a usable catalog, which is a failure to verify
 * rather than an empty one.
 */
export function parseCodexModelCatalog(
  modelsStdout: string,
): readonly { slug: string; codeModeOnly: boolean }[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(modelsStdout);
  } catch {
    return null;
  }
  const catalog = codexModelCatalogSchema.safeParse(parsed);
  if (!catalog.success) return null;
  return catalog.data.models.map((model) => ({
    slug: model.slug,
    codeModeOnly: model.tool_mode != null && model.tool_mode.length > 0,
  }));
}

/**
 * Presence, executability, digest, and — where the companion has a meaningful
 * offline signal — a real start on its transport. Skipped entirely when the
 * caller declares no components, so runtimes without helpers are unaffected.
 */
async function probeCompanions(
  args: ProbeArcRuntimeHealthArgs,
  timeoutMs: number,
): Promise<
  { kind: "healthy"; detail: string } | { kind: "unhealthy"; detail: string }
> {
  const components = args.components ?? [];
  if (components.length === 0) {
    return { kind: "healthy", detail: "" };
  }
  const runLiveness = args.runLivenessProbe ?? defaultRunStdioLivenessProbe;
  const componentPath = args.componentPath;
  if (componentPath === undefined) {
    return {
      kind: "unhealthy",
      detail:
        "components were declared without a componentPath resolver, so they cannot be checked",
    };
  }
  const verified: string[] = [];

  for (const component of components) {
    const path = componentPath(component.fileName);
    const check = await checkArcRuntimeComponents({
      expectations: [
        { fileName: component.fileName, expectedDigest: component.expectedDigest },
      ],
      componentPath: () => path,
      isWindows: process.platform === "win32",
      verifyDigest: true,
    });
    const failed = check.find((entry) => !entry.ok);
    if (failed !== undefined) {
      return { kind: "unhealthy", detail: failed.detail };
    }
    if (component.livenessArgs !== undefined) {
      const liveness = await runLiveness(
        path,
        component.livenessArgs,
        timeoutMs,
      );
      if (!liveness.ok) {
        return { kind: "unhealthy", detail: liveness.detail };
      }
    }
    verified.push(component.fileName);
  }

  return {
    kind: "healthy",
    detail: `, ${verified.join(", ")} verified`,
  };
}

// Local/offline only: no account, no network call that could reach a paid
// model endpoint. Each runtime's check proves the binary can do the minimum
// real thing Arc depends on, not merely that the file exists — a valid
// checksum is not enough (plan 2.9).
export async function probeArcRuntimeHealth(
  args: ProbeArcRuntimeHealthArgs,
): Promise<ArcRuntimeHealthProbeResult> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const runProcess = args.runProcess ?? defaultRunProcess;
  const runAcpHandshake = args.runAcpHandshake ?? defaultRunOmpAcpHandshake;

  const versionProbe = await probeArcRuntimeVersion({
    executablePath: args.executablePath,
    timeoutMs,
  });
  if (versionProbe.kind === "failed") {
    return {
      kind: "unhealthy",
      detail: `version probe failed: ${versionProbe.reason}`,
    };
  }
  if (versionProbe.version !== args.expectedVersion) {
    return {
      kind: "unhealthy",
      detail: `reports version ${versionProbe.version}, expected ${args.expectedVersion}`,
    };
  }

  if (args.runtimeId === "codex") {
    const doctor = await runProcess(
      args.executablePath,
      ["doctor", "--json"],
      timeoutMs,
    );
    // The report, not the exit code, is the evidence. `doctor --json` exits
    // non-zero when *any* of its checks fails, and most of them are properties
    // of the environment rather than of the managed runtime: on a fresh profile
    // `auth.credentials` fails (no `auth.json` yet) and the process exits 1
    // while still printing the complete report — verified against the real
    // 0.155.1 binary on an empty CODEX_HOME. Authentication is a separate
    // concern with its own preflight, so a signed-out profile must not read as
    // a broken runtime.
    const features = parseCodexEnabledFeatures(doctor.stdout);
    if (features === null) {
      return {
        kind: "unhealthy",
        detail:
          "codex doctor did not report its effective feature flags, so the code-mode host cannot be confirmed enabled",
      };
    }
    // The host is the infrastructure Arc now ships; a managed Codex that
    // reports it disabled would start and then fail Code Mode on first use.
    if (!features.includes("code_mode_host")) {
      return {
        kind: "unhealthy",
        detail:
          "codex reports features.code_mode_host disabled, so Code Mode cannot work",
      };
    }
    const components = await probeCompanions(args, timeoutMs);
    if (components.kind === "unhealthy") {
      return components;
    }
    const models = await runProcess(
      args.executablePath,
      // `--bundled` skips the catalog refresh, so the probe stays offline and
      // deterministic; the bundled catalog carries the same `tool_mode` data
      // and renders in ~0.1s.
      ["debug", "models", "--bundled"],
      timeoutMs,
    );
    if (!models.ok) {
      return {
        kind: "unhealthy",
        detail: "codex could not render its own model catalog",
      };
    }
    const catalog = parseCodexModelCatalog(models.stdout);
    if (catalog === null || catalog.length === 0) {
      return {
        kind: "unhealthy",
        detail:
          "codex rendered no usable model catalog, so no Code-Mode model could be resolved",
      };
    }
    const codeModeModels = catalog.filter((model) => model.codeModeOnly).length;
    return {
      kind: "healthy",
      detail: `codex ${versionProbe.version}: version verified, doctor completed, code_mode_host enabled, ${catalog.length} models resolvable (${codeModeModels} Code-Mode)${components.detail}`,
    };
  }

  if (args.runtimeId === "claude-code") {
    const doctor = await runProcess(args.executablePath, ["doctor"], timeoutMs);
    if (!doctor.ok) {
      return {
        kind: "unhealthy",
        detail: "claude doctor did not complete successfully",
      };
    }
    return {
      kind: "healthy",
      detail: `claude-code ${versionProbe.version}: version verified, doctor completed`,
    };
  }

  const handshake = await runAcpHandshake(args.executablePath, timeoutMs);
  if (!handshake.ok) {
    return { kind: "unhealthy", detail: handshake.detail };
  }
  return {
    kind: "healthy",
    detail: `omp ${versionProbe.version}: version verified, ${handshake.detail}`,
  };
}
