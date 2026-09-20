import { describe, expect, it } from "vitest";
import {
  OmpAccountSource,
  type ArcOmpRuntime,
  type OmpBrokerOwnership,
  type OmpBrokerOwnershipRecord,
  type OmpChildProcess,
  type OmpSpawnArgs,
} from "../src/arc-account/omp-account-source.js";

// Scriptable fake for the Arc-managed OMP binary. Records every spawn, lets
// each test script stdout lines and completion, and proves the adapter only
// ever targets the Arc-managed runtime (never a global `omp` on PATH).
const RUNTIME: ArcOmpRuntime = {
  executablePath: "/arc/managed/omp",
  env: {
    PATH: "/arc/managed",
    PI_CODING_AGENT_DIR: "/arc/userData/omp/agent",
  },
};

const REGISTRY_JSON = JSON.stringify([
  { id: "anthropic", name: "Anthropic (Claude Pro/Max)" },
  { id: "kimi-code", name: "Kimi Code" },
  { id: "deepseek", name: "DeepSeek" },
]);

interface SpawnScript {
  // Complete stdout lines (newline-terminated when emitted).
  lines?: string[];
  // Additional raw stdout with NO trailing newline (interactive prompts).
  partialTail?: string;
  // Resolves wait() immediately with this code (a process that exits on its
  // own). Omit and set stayAlive for long-running processes.
  exitCode?: number;
  stayAlive?: boolean;
  // Ignores SIGTERM so only SIGKILL can end it (a wedged broker).
  ignoreSigterm?: boolean;
}

interface FetchCall {
  url: string;
  authorization: string | null;
}

interface ProcessController {
  args: OmpSpawnArgs;
  complete(result: { code: number | null; signal: NodeJS.Signals | null }): void;
  kill(signal?: NodeJS.Signals): void;
}

class FakeOmp {
  spawnCalls: OmpSpawnArgs[] = [];
  fetchCalls: FetchCall[] = [];
  writtenLines: string[] = [];
  killed: Array<{ signal?: NodeJS.Signals }> = [];
  snapshotPayload: unknown = { credentials: [] };
  private scripts: (args: OmpSpawnArgs) => SpawnScript;
  private controllers: ProcessController[] = [];
  private nextPid = 1_000;

  constructor(scripts: (args: OmpSpawnArgs) => SpawnScript) {
    this.scripts = scripts;
  }

  spawn = (args: OspArgs): OmpChildProcess => {
    const call: OmpSpawnArgs = args;
    this.spawnCalls.push(call);
    const script = this.scripts(call);
    const stdoutListeners = new Set<(chunk: string) => void>();
    const stderrListeners = new Set<(chunk: string) => void>();
    let resolveExit: (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void = () => undefined;
    const exit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      resolveExit = resolve;
    });
    let flushed = false;
    const flush = () => {
      if (flushed) return;
      flushed = true;
      let data = (script.lines ?? []).map((line) => `${line}\n`).join("");
      if (script.partialTail !== undefined) {
        data += script.partialTail;
      }
      if (data.length > 0) {
        for (const listener of stdoutListeners) listener(data);
      }
    };
    const controller: ProcessController = {
      args: call,
      complete: (result) => {
        resolveExit(result);
      },
      kill: (signal) => {
        this.killed.push({ signal });
        if (script.ignoreSigterm === true && signal !== "SIGKILL") return;
        resolveExit({ code: null, signal: signal ?? "SIGTERM" });
      },
    };
    this.controllers.push(controller);
    // A process with an immediate exit code resolves on the next microtask
    // so listeners attached right after spawn still see the output first.
    if (script.stayAlive !== true && script.exitCode !== undefined) {
      queueMicrotask(() => {
        resolveExit({ code: script.exitCode ?? 0, signal: null });
      });
    }
    return {
      pid: (this.nextPid += 1),
      onStdoutData(listener) {
        stdoutListeners.add(listener);
        // Flush synchronously on first attach so successful starts are
        // observable without real timers.
        flush();
      },
      onStderrData(listener) {
        stderrListeners.add(listener);
      },
      writeLine: (line) => {
        this.writtenLines.push(line);
      },
      kill: (signal) => {
        controller.kill(signal);
      },
      wait: () => exit,
    };
  };

  fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    this.fetchCalls.push({
      url,
      authorization:
        (init?.headers as Record<string, string> | undefined)?.authorization ??
        null,
    });
    if (url.endsWith("/v1/healthz")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith("/v1/snapshot")) {
      return new Response(JSON.stringify(this.snapshotPayload), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ error: "no route" }), {
      status: 404,
    });
  }) as typeof fetch;

  // Emulates a login/logout process finishing naturally with an exit code.
  completeProcess(args: OmpSpawnArgs, code: number): void {
    const controller = this.controllers.find(
      (entry) => entry.args === args,
    );
    if (controller === undefined) {
      throw new Error("process not found");
    }
    controller.complete({ code, signal: null });
  }
}

// Alias to keep spawn signatures terse.
type OspArgs = OmpSpawnArgs;

// Deterministically drains pending promise continuations without binding to
// wall-clock time.
async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

class ManualScheduler {
  private timers = new Map<number, () => void>();
  private nextId = 1;

  setTimer = (fn: () => void, _ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, fn);
    return id;
  };

  clearTimer = (id: unknown): void => {
    this.timers.delete(id as number);
  };

  fireAll(): void {
    for (const [id, fn] of [...this.timers]) {
      this.timers.delete(id);
      fn();
    }
  }
}

function brokerServeScript(args: OmpSpawnArgs): SpawnScript {
  if (args.argv[1] === "serve") {
    return {
      lines: [
        '{"timestamp":"t","level":"info","pid":1,"message":"auth-broker listening","url":"http://127.0.0.1:58860"}',
      ],
      stayAlive: true,
    };
  }
  if (args.argv[1] === "token") {
    return { lines: ["broker-token-xyz"], exitCode: 0 };
  }
  if (args.argv[1] === "list") {
    return { lines: [REGISTRY_JSON], exitCode: 0 };
  }
  return { exitCode: 0 };
}

function makeSource(
  fake: FakeOmp,
  scheduler = new ManualScheduler(),
  args: {
    resolveRuntime?: () => Promise<ArcOmpRuntime | null>;
    brokerIdleTtlMs?: number;
    brokerHoldTtlMs?: number;
    brokerStopTimeoutMs?: number;
    snapshotTtlMs?: number;
    now?: () => number;
    brokerOwnership?: OmpBrokerOwnership;
  } = {},
) {
  const source = new OmpAccountSource({
    resolveRuntime:
      args.resolveRuntime ??
      (async () => ({ ...RUNTIME, env: { ...RUNTIME.env } })),
    spawn: fake.spawn,
    fetchImpl: fake.fetchImpl,
    now: args.now,
    scheduler,
    brokerIdleTtlMs: args.brokerIdleTtlMs ?? 60_000,
    brokerHoldTtlMs: args.brokerHoldTtlMs ?? 1_800_000,
    brokerStopTimeoutMs: args.brokerStopTimeoutMs ?? 5_000,
    snapshotTtlMs: args.snapshotTtlMs ?? 5_000,
    loginStartTimeoutMs: 500,
    ...(args.brokerOwnership === undefined
      ? {}
      : { brokerOwnership: args.brokerOwnership }),
  });
  return { source, scheduler };
}

class FakeBrokerOwnership implements OmpBrokerOwnership {
  records: OmpBrokerOwnershipRecord[] = [];
  cleared: number[] = [];

  async record(record: OmpBrokerOwnershipRecord): Promise<void> {
    this.records.push(record);
  }

  async clear(pid: number): Promise<void> {
    this.cleared.push(pid);
  }
}

const SECRET_ACCESS = "sk-live-access-token-AAA";
const SECRET_REFRESH = "refresh-token-BBB";
const SECRET_API_KEY = "sk-deepseek-CCC";

describe("OmpAccountSource provider vs account distinction", () => {
  it("reports registry providers without inventing accounts for them", async () => {
    const fake = new FakeOmp(brokerServeScript);
    const { source } = makeSource(fake);
    // Registry reports three providers; the credential store is empty.
    const providers = await source.listOmpProviders();
    expect(providers.map((p) => p.id)).toEqual([
      "anthropic",
      "kimi-code",
      "deepseek",
    ]);
    expect(providers.every((p) => p.connectionState === "not-connected")).toBe(
      true,
    );
    expect(providers.every((p) => p.hasAccounts === false)).toBe(true);
    const accounts = await source.listAccounts();
    expect(accounts).toEqual([]);
  });

  it("never exposes OMP credential secrets through ArcAccount", async () => {
    const fake = new FakeOmp(brokerServeScript);
    fake.snapshotPayload = {
      credentials: [
        {
          id: 7,
          provider: "anthropic",
          identityKey: "anthropic:uuid-1",
          credential: {
            type: "oauth",
            access: SECRET_ACCESS,
            refresh: SECRET_REFRESH,
            expires: 9999999999,
            email: "adnan@example.com",
            accountId: "acc-uuid-1",
          },
          blocks: [],
        },
        {
          id: 9,
          provider: "deepseek",
          identityKey: null,
          credential: { type: "api_key", key: SECRET_API_KEY },
          blocks: [],
        },
      ],
    };
    const { source } = makeSource(fake);
    const accounts = await source.listAccounts();
    const serialized = JSON.stringify(accounts);
    expect(serialized).not.toContain(SECRET_ACCESS);
    expect(serialized).not.toContain(SECRET_REFRESH);
    expect(serialized).not.toContain(SECRET_API_KEY);
    expect(accounts).toHaveLength(2);
  });
});

describe("OmpAccountSource inventory", () => {
  it("maps OAuth and api_key credentials to ArcAccount with OMP availability only", async () => {
    const fake = new FakeOmp(brokerServeScript);
    fake.snapshotPayload = {
      credentials: [
        {
          id: 7,
          provider: "anthropic",
          credential: {
            type: "oauth",
            email: "adnan@example.com",
            accountId: "acc-uuid-1",
            orgName: "Acme",
          },
          blocks: [],
        },
        {
          id: 9,
          provider: "deepseek",
          credential: { type: "api_key" },
          blocks: [],
        },
      ],
    };
    const { source } = makeSource(fake);
    const accounts = await source.listAccounts();
    expect(accounts).toMatchObject([
      {
        id: "omp:anthropic:7",
        sourceKind: "omp",
        providerFamily: "anthropic",
        providerLabel: "Anthropic (Claude Pro/Max)",
        accountKey: "omp:anthropic:acc-uuid-1",
        email: "adnan@example.com",
        planLabel: null,
        authState: "connected",
        enabled: true,
        availableThrough: ["omp"],
      },
      {
        id: "omp:deepseek:9",
        providerFamily: "deepseek",
        accountKey: null,
        email: null,
        authState: "connected",
        availableThrough: ["omp"],
      },
    ]);
    for (const account of accounts) {
      expect(account.availableThrough).toEqual(["omp"]);
    }
  });

  it("preserves multiple accounts per provider without collapsing", async () => {
    const fake = new FakeOmp(brokerServeScript);
    fake.snapshotPayload = {
      credentials: [
        {
          id: 1,
          provider: "kimi-code",
          credential: { type: "oauth", email: "a@x.com", accountId: "k1" },
          blocks: [],
        },
        {
          id: 2,
          provider: "kimi-code",
          credential: { type: "oauth", email: "b@x.com", accountId: "k2" },
          blocks: [],
        },
      ],
    };
    const { source } = makeSource(fake);
    const accounts = await source.listAccounts();
    expect(accounts).toHaveLength(2);
    expect(new Set(accounts.map((a) => a.accountKey))).toEqual(
      new Set(["omp:kimi-code:k1", "omp:kimi-code:k2"]),
    );
  });

  it("surfaces the credential identity each OMP account can be pinned by", async () => {
    const fake = new FakeOmp(brokerServeScript);
    fake.snapshotPayload = {
      credentials: [
        {
          id: 2,
          provider: "kimi-code",
          identityKey: "account:acct-a",
          credential: { type: "oauth", email: "a@x.com", accountId: "acct-a" },
          blocks: [],
        },
        {
          id: 5,
          provider: "kimi-code",
          credential: { type: "oauth", email: "b@x.com", accountId: "acct-b" },
          blocks: [],
        },
        {
          id: 9,
          provider: "opencode-go",
          identityKey: "",
          credential: { type: "api_key" },
          blocks: [],
        },
      ],
    };
    const { source } = makeSource(fake);
    const accounts = await source.listAccounts();
    expect(accounts.map((a) => [a.accountKey, a.identityKey])).toEqual([
      ["omp:kimi-code:acct-a", "account:acct-a"],
      ["omp:kimi-code:acct-b", null],
      [null, null],
    ]);
  });

  it("maps an active credential block to a disabled auth state", async () => {
    const fake = new FakeOmp(brokerServeScript);
    fake.snapshotPayload = {
      credentials: [
        {
          id: 3,
          provider: "anthropic",
          credential: { type: "oauth", email: "a@x.com", accountId: "u1" },
          blocks: [{ blockScope: "api", blockedUntilMs: Date.now() + 60_000 }],
        },
      ],
    };
    const { source } = makeSource(fake);
    const [account] = await source.listAccounts();
    expect(account?.authState).toBe("disabled");
    expect(account?.enabled).toBe(true);
  });

  it("marks providers with stored api keys as api-key auth method", async () => {
    const fake = new FakeOmp(brokerServeScript);
    fake.snapshotPayload = {
      credentials: [
        {
          id: 4,
          provider: "deepseek",
          credential: { type: "api_key" },
          blocks: [],
        },
      ],
    };
    const { source } = makeSource(fake);
    const providers = await source.listOmpProviders();
    expect(providers.find((p) => p.id === "deepseek")).toMatchObject({
      authMethod: "api-key",
      connectionState: "connected",
      hasAccounts: true,
    });
    expect(providers.find((p) => p.id === "anthropic")?.authMethod).toBe(
      "oauth",
    );
  });
});

describe("OmpAccountSource broker lifecycle and security", () => {
  it("starts the broker lazily, caches snapshots, and stops it on idle", async () => {
    const fake = new FakeOmp(brokerServeScript);
    const scheduler = new ManualScheduler();
    const { source } = makeSource(fake, scheduler, { brokerIdleTtlMs: 1_000 });

    await source.listAccounts();
    const brokerSpawns = fake.spawnCalls.filter((c) => c.argv[1] === "serve");
    expect(brokerSpawns).toHaveLength(1);
    // Ephemeral loopback bind only, against the Arc-managed binary.
    expect(brokerSpawns[0]?.argv).toContain("127.0.0.1:0");
    expect(brokerSpawns[0]?.executablePath).toBe("/arc/managed/omp");
    // Token obtained through the official command, not by reading OMP files.
    expect(fake.spawnCalls.some((c) => c.argv[1] === "token")).toBe(true);
    expect(
      fake.fetchCalls.every((c) => c.url.startsWith("http://127.0.0.1:")),
    ).toBe(true);
    expect(
      fake.fetchCalls.every(
        (c) => c.authorization === "Bearer broker-token-xyz",
      ),
    ).toBe(true);

    // A second read inside the TTL reuses broker and snapshot.
    await source.listAccounts();
    expect(fake.spawnCalls.filter((c) => c.argv[1] === "serve")).toHaveLength(1);
    expect(
      fake.fetchCalls.filter((c) => c.url.endsWith("/v1/snapshot")),
    ).toHaveLength(1);

    // Idle shutdown actually kills the broker process (the shutdown runs
    // asynchronously off the fired timer).
    scheduler.fireAll();
    await flushMicrotasks();
    expect(fake.killed.some((k) => k.signal === "SIGTERM")).toBe(true);

    // The next read starts a fresh broker: status reads never leave a
    // permanent OMP process behind.
    await source.listAccounts();
    expect(fake.spawnCalls.filter((c) => c.argv[1] === "serve")).toHaveLength(2);
  });

  it("records who owns the broker and clears the record on shutdown", async () => {
    const fake = new FakeOmp(brokerServeScript);
    const ownership = new FakeBrokerOwnership();
    const { source } = makeSource(fake, new ManualScheduler(), {
      brokerOwnership: ownership,
    });

    await source.listAccounts();
    expect(ownership.records).toEqual([
      {
        executablePath: "/arc/managed/omp",
        pid: 1_001,
        startedAt: expect.any(String),
      },
    ]);

    await source.shutdown();
    expect(ownership.cleared).toEqual([1_001]);
    expect(fake.killed.some((k) => k.signal === "SIGTERM")).toBe(true);
  });

  it("escalates to SIGKILL when a broker ignores SIGTERM", async () => {
    const fake = new FakeOmp((args) => {
      const script = brokerServeScript(args);
      return args.argv[1] === "serve"
        ? { ...script, ignoreSigterm: true }
        : script;
    });
    const scheduler = new ManualScheduler();
    const { source } = makeSource(fake, scheduler, { brokerStopTimeoutMs: 500 });

    await source.listAccounts();
    const stopping = source.shutdown();
    await flushMicrotasks();
    expect(fake.killed).toEqual([{ signal: "SIGTERM" }]);
    scheduler.fireAll();
    await stopping;
    expect(fake.killed).toEqual([
      { signal: "SIGTERM" },
      { signal: "SIGKILL" },
    ]);
  });

  it("kills an in-flight login child only on disposal, not on idle shutdown", async () => {
    const fake = new FakeOmp((args) => {
      if (args.argv[1] === "login") {
        return {
          lines: [
            "Open this URL in your browser:",
            "https://kimi.example.com/authorize?client=omp",
          ],
          stayAlive: true,
        };
      }
      return brokerServeScript(args);
    });
    const scheduler = new ManualScheduler();
    const { source } = makeSource(fake, scheduler, { brokerIdleTtlMs: 1_000 });

    const login = await source.startOmpLogin("kimi-code");
    expect(login.sessionId.length).toBeGreaterThan(0);

    scheduler.fireAll();
    await flushMicrotasks();
    expect(fake.killed).toEqual([]);

    await source.dispose();
    expect(fake.killed).toEqual([{ signal: "SIGTERM" }]);
  });

  it("keeps the broker alive while a pinned execution holds it", async () => {
    const fake = new FakeOmp(brokerServeScript);
    const scheduler = new ManualScheduler();
    const clock = { value: 1_800_000_000_000 };
    const { source } = makeSource(fake, scheduler, {
      brokerIdleTtlMs: 1_000,
      brokerHoldTtlMs: 10_000,
      now: () => clock.value,
    });

    const connection = await source.holdBrokerForExecution();
    expect(connection).toEqual({
      url: "http://127.0.0.1:58860",
      token: "broker-token-xyz",
    });

    // An idle timer firing inside the hold must not kill the broker the
    // pinned provider process resolves its credentials through.
    scheduler.fireAll();
    await flushMicrotasks();
    expect(fake.killed).toEqual([]);

    // A later resolution for the same provider extends the hold instead of
    // starting a second broker.
    expect(source.renewBrokerHold()).toBe(true);
    clock.value += 9_000;
    scheduler.fireAll();
    await flushMicrotasks();
    expect(fake.killed).toEqual([]);
    expect(fake.spawnCalls.filter((c) => c.argv[1] === "serve")).toHaveLength(1);

    // Past the hold with no renewal, the normal idle shutdown resumes.
    clock.value += 20_000;
    expect(source.renewBrokerHold()).toBe(false);
    scheduler.fireAll();
    scheduler.fireAll();
    await flushMicrotasks();
    expect(fake.killed.some((k) => k.signal === "SIGTERM")).toBe(true);

    await source.shutdown();
    expect(source.renewBrokerHold()).toBe(false);
  });

  it("rejects a non-loopback broker address before using the token", async () => {
    const fake = new FakeOmp((args) => {
      if (args.argv[1] === "serve") {
        return {
          lines: [
            '{"timestamp":"t","level":"info","pid":1,"message":"auth-broker listening","url":"http://192.168.1.50:9999"}',
          ],
          stayAlive: true,
        };
      }
      if (args.argv[1] === "token") {
        return { lines: ["broker-token-xyz"], exitCode: 0 };
      }
      return { exitCode: 0 };
    });
    const { source } = makeSource(fake);
    await expect(source.listAccounts()).rejects.toMatchObject({
      code: "account-source-unavailable",
      detail: expect.stringContaining("non-loopback"),
    });
    // The bearer token never left the source: no HTTP call was ever made.
    expect(fake.fetchCalls).toEqual([]);
  });

  it("fails with omp-runtime-unavailable when the managed runtime is absent", async () => {
    const fake = new FakeOmp(brokerServeScript);
    const { source } = makeSource(fake, new ManualScheduler(), {
      resolveRuntime: async () => null,
    });
    await expect(source.listAccounts()).rejects.toMatchObject({
      code: "omp-runtime-unavailable",
    });
    await expect(source.listOmpProviders()).rejects.toMatchObject({
      code: "omp-runtime-unavailable",
    });
    // A global omp is never consulted either.
    expect(fake.spawnCalls).toEqual([]);
  });

  it("applies Arc OMP isolation to every OMP child", async () => {
    const fake = new FakeOmp(brokerServeScript);
    const { source } = makeSource(fake);
    await source.listOmpProviders();
    for (const call of fake.spawnCalls) {
      expect(call.env["PI_CODING_AGENT_DIR"]).toBe("/arc/userData/omp/agent");
    }
  });
});

describe("OmpAccountSource login flows", () => {
  const loginScript =
    (lines: string[]) =>
    (args: OmpSpawnArgs): SpawnScript => {
      if (args.argv[1] === "list") {
        return { lines: [REGISTRY_JSON], exitCode: 0 };
      }
      if (args.argv[1] === "login") {
        return { lines, stayAlive: true };
      }
      return brokerServeScript(args);
    };

  it("starts an OAuth login, polls waiting, and reports connected on success", async () => {
    const fake = new FakeOmp(
      loginScript([
        "Open this URL in your browser:",
        "https://kimi.example.com/authorize?client=omp",
      ]),
    );
    const { source } = makeSource(fake);
    const challenge = await source.startOmpLogin("kimi-code");
    expect(challenge).toMatchObject({
      provider: "kimi-code",
      kind: "oauth",
      authorizeUrl: "https://kimi.example.com/authorize?client=omp",
      expiresAt: null,
    });

    const waiting = await source.pollOmpLogin(challenge.sessionId);
    expect(waiting.state).toBe("waiting-for-user");

    // The user finishes in the browser; the login process exits 0 after OMP
    // persisted the credential.
    const loginProc = fake.spawnCalls.find((c) => c.argv[1] === "login")!;
    expect(loginProc.argv).toEqual(["auth-broker", "login", "kimi-code"]);
    fake.snapshotPayload = {
      credentials: [
        {
          id: 11,
          provider: "kimi-code",
          credential: { type: "oauth", email: "a@x.com", accountId: "k1" },
          blocks: [],
        },
      ],
    };
    fake.completeProcess(loginProc, 0);
    const poll = await source.pollOmpLogin(challenge.sessionId);
    expect(poll.state).toBe("connected");
    expect(poll.account).toMatchObject({
      providerFamily: "kimi-code",
      authState: "connected",
      availableThrough: ["omp"],
    });
  });

  it("classifies device-code flows and surfaces the user code (Kimi shape)", async () => {
    const fake = new FakeOmp(
      loginScript([
        "Requesting device authorization...",
        "",
        "Open this URL in your browser:",
        "https://www.kimi.com/code/authorize_device?user_code=W8KT-XSI2",
        "Enter code: W8KT-XSI2",
        "",
        "Waiting for device authorization...",
      ]),
    );
    const { source } = makeSource(fake);
    const challenge = await source.startOmpLogin("kimi-code");
    expect(challenge.kind).toBe("oauth");
    expect(challenge.flow).toBe("device");
    expect(challenge.userCode).toBe("W8KT-XSI2");
    expect(challenge.authorizeUrl).toBe(
      "https://kimi.ai/code/authorize_device?user_code=W8KT-XSI2",
    );
  });

  it("rewrites www.kimi.com challenge URLs to kimi.ai only for kimi-code", async () => {
    const fake = new FakeOmp(
      loginScript([
        "Open this URL in your browser:",
        "https://www.kimi.com/code/authorize_device?user_code=W8KT-XSI2",
        "Enter code: W8KT-XSI2",
      ]),
    );
    const { source } = makeSource(fake);
    const kimi = await source.startOmpLogin("kimi-code");
    expect(kimi.authorizeUrl).toBe(
      "https://kimi.ai/code/authorize_device?user_code=W8KT-XSI2",
    );

    const other = new FakeOmp(
      loginScript([
        "Open this URL in your browser:",
        "https://www.kimi.com/some/other/path",
      ]),
    );
    const otherSource = makeSource(other).source;
    const untouched = await otherSource.startOmpLogin("deepseek");
    expect(untouched.authorizeUrl).toBe("https://www.kimi.com/some/other/path");
  });

  it("classifies plain browser OAuth flows as browser", async () => {
    const fake = new FakeOmp(
      loginScript([
        "Open this URL in your browser:",
        "https://provider.example.com/oauth/authorize?client_id=omp",
      ]),
    );
    const { source } = makeSource(fake);
    const challenge = await source.startOmpLogin("kimi-code");
    expect(challenge.flow).toBe("browser");
    expect(challenge.userCode).toBeNull();
  });

  it("classifies device flows from the instructions when the URL has no user_code", async () => {
    const fake = new FakeOmp(
      loginScript([
        "Open this URL in your browser:",
        "https://provider.example.com/activate",
        "Enter code: AB3D-9F21",
      ]),
    );
    const { source } = makeSource(fake);
    const challenge = await source.startOmpLogin("kimi-code");
    expect(challenge.flow).toBe("device");
    expect(challenge.userCode).toBe("AB3D-9F21");
  });

  it("rejects logins for providers OMP does not report", async () => {
    const fake = new FakeOmp(brokerServeScript);
    const { source } = makeSource(fake);
    await expect(source.startOmpLogin("not-a-provider")).rejects.toMatchObject({
      code: "provider-not-found",
    });
  });

  it("fails login start when the process dies before printing a URL", async () => {
    const fake = new FakeOmp((args) => {
      if (args.argv[1] === "list") {
        return { lines: [REGISTRY_JSON], exitCode: 0 };
      }
      if (args.argv[1] === "login") {
        return { lines: [], exitCode: 1 };
      }
      return brokerServeScript(args);
    });
    const { source } = makeSource(fake);
    await expect(source.startOmpLogin("kimi-code")).rejects.toMatchObject({
      code: "login-failed",
    });
  });

  it("accepts an API key only through the OMP child stdin and never stores it", async () => {
    const fake = new FakeOmp((args) => {
      if (args.argv[1] === "list") {
        return { lines: [REGISTRY_JSON], exitCode: 0 };
      }
      if (args.argv[1] === "login") {
        // Interactive prompts have no trailing newline.
        return { partialTail: "Paste your DeepSeek API key (sk-...): ", stayAlive: true };
      }
      return brokerServeScript(args);
    });
    const { source } = makeSource(fake);
    const challenge = await source.startOmpLogin("deepseek");
    expect(challenge.kind).toBe("api-key");
    expect(challenge.authorizeUrl).toBeNull();

    source.submitOmpLoginKey(challenge.sessionId, SECRET_API_KEY);
    expect(fake.writtenLines).toEqual([SECRET_API_KEY]);
    const loginProc = fake.spawnCalls.find((c) => c.argv[1] === "login")!;
    fake.snapshotPayload = {
      credentials: [
        {
          id: 5,
          provider: "deepseek",
          credential: { type: "api_key" },
          blocks: [],
        },
      ],
    };
    fake.completeProcess(loginProc, 0);
    const poll = await source.pollOmpLogin(challenge.sessionId);
    expect(poll.state).toBe("connected");
    expect(JSON.stringify(poll.account)).not.toContain(SECRET_API_KEY);
  });

  it("treats URL-then-key-prompt flows as api-key logins (DeepSeek shape)", async () => {
    const fake = new FakeOmp((args) => {
      if (args.argv[1] === "list") {
        return { lines: [REGISTRY_JSON], exitCode: 0 };
      }
      if (args.argv[1] === "login") {
        return {
          lines: [
            "Open this URL in your browser:",
            "https://platform.deepseek.com/api_keys",
            "Create or copy your API key from the DeepSeek dashboard",
          ],
          partialTail: "Paste your DeepSeek API key (sk-...): ",
          stayAlive: true,
        };
      }
      return brokerServeScript(args);
    });
    const { source } = makeSource(fake);
    const challenge = await source.startOmpLogin("deepseek");
    // The dashboard link is preserved for presentation, but the flow awaits
    // a key, not a browser redirect.
    expect(challenge.kind).toBe("api-key");
    expect(challenge.authorizeUrl).toBe(
      "https://platform.deepseek.com/api_keys",
    );
    source.submitOmpLoginKey(challenge.sessionId, SECRET_API_KEY);
    expect(fake.writtenLines).toEqual([SECRET_API_KEY]);
    fake.completeProcess(
      fake.spawnCalls.find((c) => c.argv[1] === "login")!,
      0,
    );
    const poll = await source.pollOmpLogin(challenge.sessionId);
    expect(poll.state).toBe("connected");
  });

  it("rejects key submission for an OAuth session", async () => {
    const fake = new FakeOmp(
      loginScript(["Open this URL in your browser:", "https://x.example.com/auth"]),
    );
    const { source } = makeSource(fake);
    const challenge = await source.startOmpLogin("kimi-code");
    let caught: unknown;
    try {
      source.submitOmpLoginKey(challenge.sessionId, "sk-x");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "auth-not-supported" });
  });

  it("cancels a pending login by terminating the OMP process", async () => {
    const fake = new FakeOmp(
      loginScript(["Open this URL in your browser:", "https://x.example.com/auth"]),
    );
    const { source } = makeSource(fake);
    const challenge = await source.startOmpLogin("kimi-code");
    await source.cancelOmpLogin(challenge.sessionId);
    expect(fake.killed.some((k) => k.signal === "SIGTERM")).toBe(true);
    const poll = await source.pollOmpLogin(challenge.sessionId);
    expect(poll.state).toBe("failed");
  });

  it("reports a failed login with a sanitized exit", async () => {
    const fake = new FakeOmp(
      loginScript(["Open this URL in your browser:", "https://x.example.com/auth"]),
    );
    const { source } = makeSource(fake);
    const challenge = await source.startOmpLogin("kimi-code");
    fake.completeProcess(
      fake.spawnCalls.find((c) => c.argv[1] === "login")!,
      1,
    );
    const poll = await source.pollOmpLogin(challenge.sessionId);
    expect(poll.state).toBe("failed");
    expect(poll.account).toBeNull();
  });
});

describe("OmpAccountSource removal and unsupported operations", () => {
  it("removes a provider's sole credential through omp auth-broker logout", async () => {
    const fake = new FakeOmp((args) => {
      if (args.argv[1] === "logout") return { lines: [], exitCode: 0 };
      return brokerServeScript(args);
    });
    fake.snapshotPayload = {
      credentials: [
        {
          id: 7,
          provider: "anthropic",
          credential: { type: "oauth", accountId: "u1" },
          blocks: [],
        },
      ],
    };
    const { source } = makeSource(fake);
    const accounts = await source.listAccounts();
    await source.removeAccount(accounts[0]!.sourceId);
    expect(
      fake.spawnCalls.some(
        (c) => c.argv[1] === "logout" && c.argv[2] === "anthropic",
      ),
    ).toBe(true);
  });

  it("refuses per-account removal when the provider has multiple accounts", async () => {
    const fake = new FakeOmp(brokerServeScript);
    fake.snapshotPayload = {
      credentials: [
        {
          id: 1,
          provider: "kimi-code",
          credential: { type: "oauth", accountId: "k1" },
          blocks: [],
        },
        {
          id: 2,
          provider: "kimi-code",
          credential: { type: "oauth", accountId: "k2" },
          blocks: [],
        },
      ],
    };
    const { source } = makeSource(fake);
    const accounts = await source.listAccounts();
    await expect(
      source.removeAccount(accounts[0]!.sourceId),
    ).rejects.toMatchObject({ code: "disconnect-failed" });
    // No logout was attempted.
    expect(fake.spawnCalls.some((c) => c.argv[1] === "logout")).toBe(false);
  });

  it("honestly reports operations OMP does not support", async () => {
    const fake = new FakeOmp(brokerServeScript);
    const { source } = makeSource(fake);
    await expect(
      source.setAccountEnabled("anthropic:1", false),
    ).rejects.toMatchObject({ code: "unsupported-provider" });
    await expect(
      source.setAccountPriority("anthropic:1", 1),
    ).rejects.toMatchObject({ code: "unsupported-provider" });
    await expect(source.reorderAccounts("anthropic", [])).rejects.toMatchObject({
      code: "unsupported-provider",
    });
    await expect(source.startOpenAiLogin()).rejects.toMatchObject({
      code: "unsupported-provider",
    });
  });

  it("throws account-not-found for unknown source ids", async () => {
    const fake = new FakeOmp(brokerServeScript);
    const { source } = makeSource(fake);
    await expect(source.getAccount("anthropic:404")).rejects.toMatchObject({
      code: "account-not-found",
    });
  });
});
