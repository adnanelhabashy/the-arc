import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAppServerLaunch } from "./bridge.js";

afterEach(() => vi.unstubAllEnvs());

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
    expect(launch).toEqual({ command: "codex", args: ["app-server"] });
    expect(JSON.stringify(launch.args)).not.toContain("supports_websockets");
  });

  it("does not partially route when either required variable is missing", () => {
    vi.stubEnv("CODEX_OPENAI_BASE_URL", "https://bb.example/pool/v1");
    expect(resolveAppServerLaunch()).toEqual({
      command: "codex",
      args: ["app-server"],
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
      expect(launch).toEqual({ command: "codex", args: ["app-server"] });
      expect(JSON.stringify(launch.args)).not.toContain("parent.example");
      expect(JSON.stringify(launch.args)).not.toContain(
        "inherited-parent-token",
      );
    },
  );
});
