import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArcAccount } from "@bb/arc-domains";
import {
  describeArcOmpExecutionPin,
  resolveArcOmpExecutionEnv,
} from "../src/omp-execution-env.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const BROKER = { url: "http://127.0.0.1:58860", token: "broker-token-xyz" };

async function poolDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "arc-omp-pin-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function account(args: {
  providerFamily: string;
  accountKey: string | null;
  identityKey: string | null;
}): ArcAccount {
  return {
    id: `omp:${args.providerFamily}:1`,
    sourceId: `${args.providerFamily}:1`,
    sourceKind: "omp",
    providerFamily: args.providerFamily,
    providerLabel: args.providerFamily,
    accountKey: args.accountKey,
    identityKey: args.identityKey,
    email: null,
    planLabel: null,
    authState: "connected",
    enabled: true,
    availableThrough: ["omp"],
    observedAt: 1_800_000_000_000,
  };
}

const KIMI_A = account({
  providerFamily: "kimi-code",
  accountKey: "omp:kimi-code:acct-a",
  identityKey: "account:acct-a",
});
const KIMI_B = account({
  providerFamily: "kimi-code",
  accountKey: "omp:kimi-code:acct-b",
  identityKey: "account:acct-b",
});

function holdBroker(): Promise<typeof BROKER> {
  return Promise.resolve(BROKER);
}

describe("resolveArcOmpExecutionEnv", () => {
  it("pins a thread to its OMP account and nothing else", async () => {
    const poolFileDirectory = await poolDirectory();
    const { entries, pin } = await resolveArcOmpExecutionEnv({
      accountKey: "omp:kimi-code:acct-a",
      accounts: [KIMI_A, KIMI_B],
      poolFileDirectory,
      holdBroker,
    });
    expect(pin).toEqual({
      kind: "pinned",
      provider: "kimi-code",
      identityKey: "account:acct-a",
    });
    expect(entries).toHaveLength(3);
    expect(
      Object.fromEntries(
        entries.map((entry) => [
          entry.name,
          typeof entry.value === "string" ? entry.value : entry.value.serverPath,
        ]),
      ),
    ).toMatchObject({
      OMP_AUTH_BROKER_URL: BROKER.url,
      OMP_AUTH_BROKER_TOKEN: BROKER.token,
    });

    const poolFile = entries.find(
      (entry) => entry.name === "OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
    );
    const poolFilePath =
      typeof poolFile?.value === "string" ? poolFile.value : "";
    expect(poolFilePath.startsWith(poolFileDirectory)).toBe(true);
    expect(JSON.parse(await readFile(poolFilePath, "utf8"))).toEqual({
      "kimi-code": ["account:acct-a"],
    });
    // Credential identities only: never a token, key, or email.
    const contents = await readFile(poolFilePath, "utf8");
    expect(contents).not.toContain(BROKER.token);
    expect(contents).not.toContain("@");
    expect((await stat(poolFilePath)).mode & 0o777).toBe(0o600);
    expect(entries.every((entry) => entry.reason.length > 0)).toBe(true);
    expect(describeArcOmpExecutionPin(pin)).toBeNull();
  });

  it("contributes nothing for an Auto thread so OMP keeps its own selection", async () => {
    const poolFileDirectory = await poolDirectory();
    let brokerHeld = false;
    const { entries, pin } = await resolveArcOmpExecutionEnv({
      accountKey: null,
      accounts: [KIMI_A, KIMI_B],
      poolFileDirectory,
      holdBroker: () => {
        brokerHeld = true;
        return holdBroker();
      },
    });
    expect(entries).toEqual([]);
    expect(pin).toEqual({ kind: "unpinned" });
    expect(brokerHeld).toBe(false);
    expect(await readdir(poolFileDirectory)).toEqual([]);
  });

  it("excludes the provider when the pinned account is no longer stored", async () => {
    const poolFileDirectory = await poolDirectory();
    const { entries, pin } = await resolveArcOmpExecutionEnv({
      accountKey: "omp:kimi-code:acct-gone",
      accounts: [KIMI_B],
      poolFileDirectory,
      holdBroker,
    });
    expect(pin).toEqual({ kind: "unavailable", provider: "kimi-code" });
    const poolFilePath = entries.find(
      (entry) => entry.name === "OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
    )?.value;
    expect(
      typeof poolFilePath === "string"
        ? JSON.parse(await readFile(poolFilePath, "utf8"))
        : null,
    ).toEqual({ "kimi-code": [] });
    expect(describeArcOmpExecutionPin(pin)).toContain("kimi-code");
  });

  it("excludes every stored account when the thread is bound to a non-OMP one", async () => {
    const poolFileDirectory = await poolDirectory();
    const { entries, pin } = await resolveArcOmpExecutionEnv({
      accountKey: "openai:chatgpt:acc-1",
      accounts: [KIMI_A, KIMI_B],
      poolFileDirectory,
      holdBroker,
    });
    expect(pin).toEqual({ kind: "not-omp-account" });
    const poolFilePath = entries.find(
      (entry) => entry.name === "OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
    )?.value;
    expect(
      typeof poolFilePath === "string"
        ? JSON.parse(await readFile(poolFilePath, "utf8"))
        : null,
    ).toEqual({ "kimi-code": [] });
    expect(describeArcOmpExecutionPin(pin)).toContain("not an OMP account");
  });

  it("reuses one pool file per pin across threads and turns", async () => {
    const poolFileDirectory = await poolDirectory();
    const first = await resolveArcOmpExecutionEnv({
      accountKey: "omp:kimi-code:acct-a",
      accounts: [KIMI_A, KIMI_B],
      poolFileDirectory,
      holdBroker,
    });
    const second = await resolveArcOmpExecutionEnv({
      accountKey: "omp:kimi-code:acct-a",
      accounts: [KIMI_B, KIMI_A],
      poolFileDirectory,
      holdBroker,
    });
    const other = await resolveArcOmpExecutionEnv({
      accountKey: "omp:kimi-code:acct-b",
      accounts: [KIMI_A, KIMI_B],
      poolFileDirectory,
      holdBroker,
    });
    expect(first.entries).toEqual(second.entries);
    expect(await readdir(poolFileDirectory)).toHaveLength(2);
    expect(other.entries).not.toEqual(first.entries);
  });
});
