import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAppServerLaunch } from "./bridge.js";

afterEach(() => vi.unstubAllEnvs());

const BASE_ARGS = [
  "app-server",
  "-c",
  "features.code_mode_host=false",
  "-c",
  "check_for_update_on_startup=false",
];

describe("Codex managed-runtime baseline launch", () => {
  it("always disables the code-mode host probe (Arc never installs codex-code-mode-host)", () => {
    expect(resolveAppServerLaunch({})).toEqual({
      command: "codex",
      args: BASE_ARGS,
    });
  });
});

describe("Codex Account Pool launch", () => {
  it("adds an in-memory base URL and environment-backed hub header", () => {
    vi.stubEnv("CODEX_OPENAI_BASE_URL", "https://bb.example/pool/v1");
    vi.stubEnv("CODEX_POOL_AUTH_TOKEN", "secret-machine-token");
    const launch = resolveAppServerLaunch();
    expect(launch.command).toBe("codex");
    expect(launch.args).toContain(
      'openai_base_url="https://bb.example/pool/v1"',
    );
    expect(launch.args).toContain('model_provider="bb-account-pool"');
    expect(launch.args).toContain(
      'model_providers.bb-account-pool.env_http_headers.x-bb-account-pool-token="CODEX_POOL_AUTH_TOKEN"',
    );
    expect(launch.args).toContain(
      "model_providers.bb-account-pool.supports_websockets=false",
    );
    expect(launch.args).toContain(
      'shell_environment_policy.exclude=["CODEX_POOL_AUTH_TOKEN"]',
    );
    expect(JSON.stringify(launch.args)).not.toContain("secret-machine-token");
  });

  it("adds a pin header when an account is resolved, never a URL path segment", () => {
    vi.stubEnv("CODEX_OPENAI_BASE_URL", "https://bb.example/pool/v1");
    vi.stubEnv("CODEX_POOL_AUTH_TOKEN", "secret-machine-token");
    vi.stubEnv("CODEX_ACCOUNT_POOL_PIN", "11111111-1111-4111-8111-111111111111");
    const launch = resolveAppServerLaunch();
    expect(launch.args).toContain(
      'openai_base_url="https://bb.example/pool/v1"',
    );
    expect(launch.args).toContain(
      'model_providers.bb-account-pool.env_http_headers.x-bb-account-pool-pin="CODEX_ACCOUNT_POOL_PIN"',
    );
    expect(
      launch.args.some((arg) => arg.includes("x-bb-account-pool-thread-id")),
    ).toBe(false);
  });

  it("adds a thread-id correlation header when Auto (no resolved account yet)", () => {
    vi.stubEnv("CODEX_OPENAI_BASE_URL", "https://bb.example/pool/v1");
    vi.stubEnv("CODEX_POOL_AUTH_TOKEN", "secret-machine-token");
    vi.stubEnv("CODEX_ACCOUNT_POOL_THREAD_ID", "thr_abc123");
    const launch = resolveAppServerLaunch();
    expect(launch.args).toContain(
      'model_providers.bb-account-pool.env_http_headers.x-bb-account-pool-thread-id="CODEX_ACCOUNT_POOL_THREAD_ID"',
    );
    expect(
      launch.args.some((arg) => arg.includes("x-bb-account-pool-pin")),
    ).toBe(false);
  });

  it("leaves Codex's default transport alone when the pool is not routed", () => {
    const launch = resolveAppServerLaunch({});
    expect(launch).toEqual({ command: "codex", args: BASE_ARGS });
    expect(JSON.stringify(launch.args)).not.toContain("supports_websockets");
    expect(JSON.stringify(launch.args)).not.toContain(
      "shell_environment_policy",
    );
  });

  it("does not partially route when either required variable is missing", () => {
    vi.stubEnv("CODEX_OPENAI_BASE_URL", "https://bb.example/pool/v1");
    expect(resolveAppServerLaunch()).toEqual({
      command: "codex",
      args: BASE_ARGS,
    });
  });
});

describe("Codex Account Pool isolation", () => {
  it.each([
    { label: "base URL", env: { CODEX_OPENAI_BASE_URL: "" } },
    { label: "hub token", env: { CODEX_POOL_AUTH_TOKEN: "" } },
    {
      label: "both values",
      env: { CODEX_OPENAI_BASE_URL: "", CODEX_POOL_AUTH_TOKEN: "" },
    },
  ])(
    "drops pool routing when an inherited $label is neutralised with an empty value",
    (args) => {
      const launch = resolveAppServerLaunch({
        CODEX_OPENAI_BASE_URL: "https://parent.example/pool/v1",
        CODEX_POOL_AUTH_TOKEN: "inherited-parent-token",
        ...args.env,
      });
      expect(launch).toEqual({ command: "codex", args: BASE_ARGS });
      expect(JSON.stringify(launch.args)).not.toContain("parent.example");
      expect(JSON.stringify(launch.args)).not.toContain(
        "inherited-parent-token",
      );
    },
  );
});

describe("Codex managed-runtime ownership", () => {
  async function fakeExecutable(dir: string, name: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(path, 0o755);
    return path;
  }

  it("runs the Arc-managed Codex even when a global codex comes first on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-managed-"));
    try {
      const globalBin = join(root, "global-bin");
      const managedDir = join(root, "arc-runtimes", "runtimes", "codex", "0.155.1");
      const globalCodex = await fakeExecutable(globalBin, "codex");
      const managedCodex = await fakeExecutable(managedDir, "codex");

      const launch = resolveAppServerLaunch({
        PATH: `${globalBin}:${managedDir}`,
        BB_ARC_RUNTIME_ROOT: join(root, "arc-runtimes"),
        BB_CODEX_BRIDGE_APP_SERVER_COMMAND: managedCodex,
      });

      expect(launch.command).toBe(managedCodex);
      expect(launch.command).not.toBe(globalCodex);
      expect(launch.args).toEqual(BASE_ARGS);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed instead of using PATH when Arc owns the runtime but names no executable", () => {
    expect(() =>
      resolveAppServerLaunch({ BB_ARC_RUNTIME_ROOT: "/arc/arc-runtimes" }),
    ).toThrow(/managed Codex runtime/);
  });

  it("rejects a configured command that is not executable", () => {
    expect(() =>
      resolveAppServerLaunch({
        BB_CODEX_BRIDGE_APP_SERVER_COMMAND: "/nonexistent/codex",
      }),
    ).toThrow(/must point to an executable Codex path/);
  });

  it("keeps resolving codex from PATH outside Arc", () => {
    expect(resolveAppServerLaunch({})).toEqual({
      command: "codex",
      args: BASE_ARGS,
    });
  });
});
