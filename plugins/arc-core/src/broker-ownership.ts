import { execFile } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  OmpBrokerOwnership,
  OmpBrokerOwnershipRecord,
} from "@bb/arc-domains/arc-account";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const BROKER_OWNERSHIP_SCHEMA_VERSION = 1;
const BROKER_OWNERSHIP_FILE_NAME = "broker-ownership.json";
const BROKER_ARGV_MARKER = "auth-broker";
const PROCESS_START_TOLERANCE_MS = 60_000;
const POLL_INTERVAL_MS = 100;

const storedBrokerOwnershipSchema = z.object({
  schemaVersion: z.literal(BROKER_OWNERSHIP_SCHEMA_VERSION),
  instanceId: z.string(),
  pid: z.number().int().positive(),
  executablePath: z.string(),
  startedAt: z.string(),
});

type StoredBrokerOwnership = z.infer<typeof storedBrokerOwnershipSchema>;

export interface ArcOmpBrokerOwnershipPaths {
  ompStateRoot: string;
}

export function arcOmpBrokerOwnershipPath(
  paths: ArcOmpBrokerOwnershipPaths,
): string {
  return join(paths.ompStateRoot, BROKER_OWNERSHIP_FILE_NAME);
}

export interface ArcOmpBrokerProcessOps {
  isRunning(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  readCommand(pid: number): Promise<string | null>;
  readElapsedSeconds(pid: number): Promise<number | null>;
  waitForExit(args: { pid: number; timeoutMs: number }): Promise<boolean>;
}

export interface ArcOmpBrokerReapResult {
  kind: "none" | "not-running" | "stopped" | "unverified" | "still-running";
  pid: number | null;
  command: string | null;
  reason: string | null;
}

async function readPsField(pid: number, field: string): Promise<string | null> {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", field]);
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function parseElapsedSeconds(raw: string): number | null {
  const match = raw
    .trim()
    .match(/^(?:(?:(\d+)-)?(\d+):)?(\d{1,2}):(\d{2})$/u);
  if (match === null) return null;
  const days = Number(match[1] ?? "0");
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, delayMs);
  });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createNodeBrokerProcessOps(): ArcOmpBrokerProcessOps {
  return {
    isRunning: isProcessRunning,
    kill(pid, signal) {
      process.kill(pid, signal);
    },
    readCommand: (pid) => readPsField(pid, "command="),
    async readElapsedSeconds(pid) {
      const raw = await readPsField(pid, "etime=");
      return raw === null ? null : parseElapsedSeconds(raw);
    },
    async waitForExit({ pid, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        if (!isProcessRunning(pid)) return true;
        await sleep(POLL_INTERVAL_MS);
      }
      return !isProcessRunning(pid);
    },
  };
}

export interface CreateNodeOmpBrokerOwnershipArgs
  extends ArcOmpBrokerOwnershipPaths {
  instanceId: string;
}

export function createNodeOmpBrokerOwnership(
  args: CreateNodeOmpBrokerOwnershipArgs,
): OmpBrokerOwnership {
  const recordPath = arcOmpBrokerOwnershipPath(args);
  return {
    async record(record: OmpBrokerOwnershipRecord) {
      const stored: StoredBrokerOwnership = {
        schemaVersion: BROKER_OWNERSHIP_SCHEMA_VERSION,
        instanceId: args.instanceId,
        ...record,
      };
      await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${recordPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(stored), { mode: 0o600 });
      await rename(temporaryPath, recordPath);
    },
    async clear(pid: number) {
      const stored = await readStoredBrokerOwnership(recordPath);
      if (stored === null || stored.pid !== pid) return;
      await removeIfPresent(recordPath);
    },
  };
}

async function removeIfPresent(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

async function readStoredBrokerOwnership(
  recordPath: string,
): Promise<StoredBrokerOwnership | null> {
  const raw = await readFile(recordPath, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = storedBrokerOwnershipSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface ReapStaleOmpBrokerArgs extends ArcOmpBrokerOwnershipPaths {
  instanceId: string;
  processOps?: ArcOmpBrokerProcessOps;
  timeoutMs?: number;
  killTimeoutMs?: number;
}

export async function reapStaleOmpBroker(
  args: ReapStaleOmpBrokerArgs,
): Promise<ArcOmpBrokerReapResult> {
  const recordPath = arcOmpBrokerOwnershipPath(args);
  const stored = await readStoredBrokerOwnership(recordPath);
  if (stored === null) {
    await removeIfPresent(recordPath);
    return { kind: "none", pid: null, command: null, reason: null };
  }
  if (stored.instanceId === args.instanceId) {
    return { kind: "none", pid: stored.pid, command: null, reason: null };
  }
  const ops = args.processOps ?? createNodeBrokerProcessOps();
  if (!ops.isRunning(stored.pid)) {
    await removeIfPresent(recordPath);
    return { kind: "not-running", pid: stored.pid, command: null, reason: null };
  }
  const command = await ops.readCommand(stored.pid);
  const ownsProcess =
    command !== null &&
    command.includes(stored.executablePath) &&
    command.includes(BROKER_ARGV_MARKER);
  if (!ownsProcess) {
    return {
      kind: "unverified",
      pid: stored.pid,
      command,
      reason: "command",
    };
  }
  const elapsedSeconds = await ops.readElapsedSeconds(stored.pid);
  const recordedStart = Date.parse(stored.startedAt);
  if (
    elapsedSeconds === null ||
    Number.isNaN(recordedStart) ||
    Math.abs(Date.now() - elapsedSeconds * 1_000 - recordedStart) >
      PROCESS_START_TOLERANCE_MS
  ) {
    return {
      kind: "unverified",
      pid: stored.pid,
      command,
      reason: "start-time",
    };
  }
  ops.kill(stored.pid, "SIGTERM");
  const exited = await ops.waitForExit({
    pid: stored.pid,
    timeoutMs: args.timeoutMs ?? 5_000,
  });
  if (!exited && ops.isRunning(stored.pid)) {
    ops.kill(stored.pid, "SIGKILL");
    const killed = await ops.waitForExit({
      pid: stored.pid,
      timeoutMs: args.killTimeoutMs ?? 2_000,
    });
    if (!killed && ops.isRunning(stored.pid)) {
      return {
        kind: "still-running",
        pid: stored.pid,
        command,
        reason: null,
      };
    }
  }
  await removeIfPresent(recordPath);
  return { kind: "stopped", pid: stored.pid, command, reason: null };
}
