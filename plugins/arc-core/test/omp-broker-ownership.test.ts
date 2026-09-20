import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  arcOmpBrokerOwnershipPath,
  createNodeOmpBrokerOwnership,
  reapStaleOmpBroker,
  type ArcOmpBrokerProcessOps,
} from "../src/broker-ownership.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function ompStateRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "arc-omp-broker-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const MANAGED_OMP = "/arc/userData/arc-runtimes/runtimes/omp/18.2.6/omp";

class FakeProcessOps implements ArcOmpBrokerProcessOps {
  killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  running = true;
  ignoreSigterm = false;
  command: string | null = `${MANAGED_OMP} auth-broker serve --bind 127.0.0.1:0`;
  elapsedSeconds: number | null = 5;

  isRunning(): boolean {
    return this.running;
  }

  kill(pid: number, signal: NodeJS.Signals): void {
    this.killed.push({ pid, signal });
    if (signal === "SIGKILL" || !this.ignoreSigterm) {
      this.running = false;
    }
  }

  async readCommand(): Promise<string | null> {
    return this.command;
  }

  async readElapsedSeconds(): Promise<number | null> {
    return this.elapsedSeconds;
  }

  async waitForExit(): Promise<boolean> {
    return !this.running;
  }
}

async function writeRecord(
  stateRoot: string,
  record: {
    instanceId: string;
    pid: number;
    startedAt: string;
    executablePath?: string;
  },
): Promise<string> {
  const recordPath = arcOmpBrokerOwnershipPath({ ompStateRoot: stateRoot });
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(
    recordPath,
    JSON.stringify({
      schemaVersion: 1,
      executablePath: record.executablePath ?? MANAGED_OMP,
      ...record,
    }),
  );
  return recordPath;
}

describe("Arc OMP broker ownership record", () => {
  it("records the launched pid under 0600 and clears it for that pid only", async () => {
    const stateRoot = await ompStateRoot();
    const ownership = createNodeOmpBrokerOwnership({
      instanceId: "instance-1",
      ompStateRoot: stateRoot,
    });

    await ownership.record({
      executablePath: MANAGED_OMP,
      pid: 4_242,
      startedAt: "2026-09-20T10:00:00.000Z",
    });
    const recordPath = arcOmpBrokerOwnershipPath({ ompStateRoot: stateRoot });
    const mode = (await stat(recordPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual({
      schemaVersion: 1,
      instanceId: "instance-1",
      executablePath: MANAGED_OMP,
      pid: 4_242,
      startedAt: "2026-09-20T10:00:00.000Z",
    });

    await ownership.clear(999);
    expect(JSON.parse(await readFile(recordPath, "utf8")).pid).toBe(4_242);

    await ownership.clear(4_242);
    await expect(stat(recordPath)).rejects.toThrow();
  });
});

describe("Arc OMP broker stale-process recovery", () => {
  it("stops a broker the record proves belongs to a previous Arc server", async () => {
    const stateRoot = await ompStateRoot();
    await writeRecord(stateRoot, {
      instanceId: "previous-server",
      pid: 4_242,
      startedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const ops = new FakeProcessOps();

    const result = await reapStaleOmpBroker({
      instanceId: "current-server",
      ompStateRoot: stateRoot,
      processOps: ops,
    });

    expect(result).toMatchObject({ kind: "stopped", pid: 4_242 });
    expect(ops.killed).toEqual([{ pid: 4_242, signal: "SIGTERM" }]);
    await expect(
      stat(arcOmpBrokerOwnershipPath({ ompStateRoot: stateRoot })),
    ).rejects.toThrow();
  });

  it("escalates to SIGKILL when the recorded broker survives SIGTERM", async () => {
    const stateRoot = await ompStateRoot();
    await writeRecord(stateRoot, {
      instanceId: "previous-server",
      pid: 4_242,
      startedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const ops = new FakeProcessOps();
    ops.ignoreSigterm = true;

    const result = await reapStaleOmpBroker({
      instanceId: "current-server",
      ompStateRoot: stateRoot,
      processOps: ops,
    });

    expect(result.kind).toBe("stopped");
    expect(ops.killed.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("leaves an unrelated process alone when the command does not match", async () => {
    const stateRoot = await ompStateRoot();
    await writeRecord(stateRoot, {
      instanceId: "previous-server",
      pid: 4_242,
      startedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const ops = new FakeProcessOps();
    ops.command = "/usr/bin/omp-real --approval-mode yolo acp";

    const result = await reapStaleOmpBroker({
      instanceId: "current-server",
      ompStateRoot: stateRoot,
      processOps: ops,
    });

    expect(result).toMatchObject({ kind: "unverified", reason: "command" });
    expect(ops.killed).toEqual([]);
  });

  it("leaves a process alone when its start time contradicts the record", async () => {
    const stateRoot = await ompStateRoot();
    await writeRecord(stateRoot, {
      instanceId: "previous-server",
      pid: 4_242,
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const ops = new FakeProcessOps();
    ops.elapsedSeconds = 5;

    const result = await reapStaleOmpBroker({
      instanceId: "current-server",
      ompStateRoot: stateRoot,
      processOps: ops,
    });

    expect(result).toMatchObject({ kind: "unverified", reason: "start-time" });
    expect(ops.killed).toEqual([]);
  });

  it("never touches the record this server wrote for its own broker", async () => {
    const stateRoot = await ompStateRoot();
    await writeRecord(stateRoot, {
      instanceId: "current-server",
      pid: 4_242,
      startedAt: new Date().toISOString(),
    });
    const ops = new FakeProcessOps();

    const result = await reapStaleOmpBroker({
      instanceId: "current-server",
      ompStateRoot: stateRoot,
      processOps: ops,
    });

    expect(result).toMatchObject({ kind: "none", pid: 4_242 });
    expect(ops.killed).toEqual([]);
  });

  it("clears a record whose process already exited, and ignores a corrupt one", async () => {
    const exitedRoot = await ompStateRoot();
    await writeRecord(exitedRoot, {
      instanceId: "previous-server",
      pid: 4_242,
      startedAt: new Date().toISOString(),
    });
    const ops = new FakeProcessOps();
    ops.running = false;
    expect(
      await reapStaleOmpBroker({
        instanceId: "current-server",
        ompStateRoot: exitedRoot,
        processOps: ops,
      }),
    ).toMatchObject({ kind: "not-running" });
    await expect(
      stat(arcOmpBrokerOwnershipPath({ ompStateRoot: exitedRoot })),
    ).rejects.toThrow();

    const corruptRoot = await ompStateRoot();
    const corruptPath = arcOmpBrokerOwnershipPath({ ompStateRoot: corruptRoot });
    await writeFile(corruptPath, "{not json");
    expect(
      await reapStaleOmpBroker({
        instanceId: "current-server",
        ompStateRoot: corruptRoot,
        processOps: new FakeProcessOps(),
      }),
    ).toMatchObject({ kind: "none" });
    await expect(stat(corruptPath)).rejects.toThrow();
  });
});
