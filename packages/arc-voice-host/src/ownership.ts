import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import type { ArcVoiceProcess } from "./process.js";

const PS_LISTING_ARGS = ["-axo", "pid=,ppid=,pgid=,lstart=,command="] as const;
const PS_FIELDS = "pid=,ppid=,pgid=,lstart=,command=";
const LSTART_FIELD_COUNT = 5;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const SYNC_READ_TIMEOUT_MS = 2_000;
const LISTING_MAX_BYTES = 16 * 1024 * 1024;

const POSIX_TOOL_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  ps: ["/bin/ps", "/usr/bin/ps"],
  lsof: ["/usr/sbin/lsof", "/usr/bin/lsof", "/sbin/lsof"],
};

export interface ArcVoiceProcessFingerprint {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly startedAt: string;
  readonly command: string;
}

export interface ArcVoiceOwnershipQuery {
  readonly port: number;
  readonly executablePath: string;
  readonly dataDir: string;
}

export type ArcVoiceProcessLookup =
  | { kind: "found"; fingerprint: ArcVoiceProcessFingerprint }
  | { kind: "gone" }
  | { kind: "unknown"; detail: string };

export type ArcVoiceOwnershipVerdict =
  | { kind: "vacant"; detail: string }
  | {
      kind: "owned";
      listener: ArcVoiceProcessFingerprint | undefined;
      duplicates: readonly ArcVoiceProcessFingerprint[];
      detail: string;
    }
  | {
      kind: "foreign";
      listener: ArcVoiceProcessFingerprint;
      duplicates: readonly ArcVoiceProcessFingerprint[];
      detail: string;
    }
  | { kind: "unsupported"; detail: string };

export interface ArcVoiceOwnershipProbe {
  probe(query: ArcVoiceOwnershipQuery): Promise<ArcVoiceOwnershipVerdict>;
}

export interface ArcVoiceAdoptedProcess extends ArcVoiceProcess {
  dispose(): void;
}

export interface ArcVoiceAdoptedProcessRequest {
  readonly fingerprint: ArcVoiceProcessFingerprint;
  readonly query: ArcVoiceOwnershipQuery;
}

export type ArcVoiceAdoptedProcessFactory = (
  request: ArcVoiceAdoptedProcessRequest,
) => ArcVoiceProcess;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitStatusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  if ("status" in error && typeof error.status === "number") {
    return error.status;
  }
  if ("code" in error && typeof error.code === "number") {
    return error.code;
  }
  return null;
}

function resolvePosixTool(name: "ps" | "lsof"): string | null {
  for (const candidate of POSIX_TOOL_CANDIDATES[name] ?? []) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function parseArcVoiceProcessListing(
  text: string,
): ArcVoiceProcessFingerprint[] {
  const fingerprints: ArcVoiceProcessFingerprint[] = [];
  for (const line of text.split("\n")) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens.length < 3 + LSTART_FIELD_COUNT) {
      continue;
    }
    const pid = Number(tokens[0]);
    const ppid = Number(tokens[1]);
    const pgid = Number(tokens[2]);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    if (!Number.isInteger(ppid) || ppid < 0) {
      continue;
    }
    if (!Number.isInteger(pgid) || pgid < 0) {
      continue;
    }
    fingerprints.push({
      pid,
      ppid,
      pgid,
      startedAt: tokens.slice(3, 3 + LSTART_FIELD_COUNT).join(" "),
      command: tokens.slice(3 + LSTART_FIELD_COUNT).join(" "),
    });
  }
  return fingerprints;
}

function lookupFromListing(
  text: string,
  pid: number,
): ArcVoiceProcessLookup {
  const fingerprint = parseArcVoiceProcessListing(text).find(
    (candidate) => candidate.pid === pid,
  );
  return fingerprint === undefined
    ? { kind: "gone" }
    : { kind: "found", fingerprint };
}

export function lookupArcVoiceProcessSync(pid: number): ArcVoiceProcessLookup {
  const ps = resolvePosixTool("ps");
  if (ps === null) {
    return { kind: "unknown", detail: "ps is not available" };
  }
  let text: string;
  try {
    text = execFileSync(ps, ["-o", PS_FIELDS, "-p", String(pid)], {
      encoding: "utf8",
      timeout: SYNC_READ_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    if (exitStatusOf(error) === 1) {
      return { kind: "gone" };
    }
    return { kind: "unknown", detail: errorMessage(error) };
  }
  return lookupFromListing(text, pid);
}

export async function lookupArcVoiceProcess(
  pid: number,
): Promise<ArcVoiceProcessLookup> {
  const ps = resolvePosixTool("ps");
  if (ps === null) {
    return { kind: "unknown", detail: "ps is not available" };
  }
  const text = await new Promise<string | null>((resolve) => {
    execFile(
      ps,
      ["-o", PS_FIELDS, "-p", String(pid)],
      { encoding: "utf8", timeout: SYNC_READ_TIMEOUT_MS },
      (error, stdout) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        if (exitStatusOf(error) === 1) {
          resolve("");
          return;
        }
        resolve(null);
      },
    );
  });
  if (text === null) {
    return { kind: "unknown", detail: `could not read process ${pid}` };
  }
  return lookupFromListing(text, pid);
}

function hasArcVoiceOption(
  command: string,
  flag: string,
  value: string,
): boolean {
  if (value.length === 0) {
    return false;
  }
  const needle = `${flag} ${value}`;
  let index = command.indexOf(needle);
  while (index !== -1) {
    const startsToken = index === 0 || command[index - 1] === " ";
    const end = index + needle.length;
    const endsToken = end === command.length || command[end] === " ";
    if (startsToken && endsToken) {
      return true;
    }
    index = command.indexOf(needle, index + 1);
  }
  return false;
}

export function isArcVoiceboxProcess(
  fingerprint: ArcVoiceProcessFingerprint,
  query: ArcVoiceOwnershipQuery,
): boolean {
  const command = fingerprint.command;
  if (
    command !== query.executablePath &&
    !command.startsWith(`${query.executablePath} `)
  ) {
    return false;
  }
  return (
    hasArcVoiceOption(command, "--port", String(query.port)) &&
    hasArcVoiceOption(command, "--data-dir", query.dataDir)
  );
}

function isGroupLeader(
  fingerprint: ArcVoiceProcessFingerprint,
): boolean {
  return fingerprint.pgid === fingerprint.pid && fingerprint.pgid > 1;
}

export function classifyArcVoiceOwnership(args: {
  fingerprints: readonly ArcVoiceProcessFingerprint[];
  listenerPids: ReadonlySet<number>;
  query: ArcVoiceOwnershipQuery;
}): ArcVoiceOwnershipVerdict {
  const { fingerprints, listenerPids, query } = args;
  const owned = fingerprints.filter((process_) =>
    isArcVoiceboxProcess(process_, query),
  );
  const ownedPids = new Set(owned.map((process_) => process_.pid));
  const ownedGroups = new Set(owned.map((process_) => process_.pgid));
  const listeners = fingerprints.filter((process_) =>
    listenerPids.has(process_.pid),
  );
  const ownedListener = listeners.find((process_) =>
    ownedPids.has(process_.pid),
  );
  const duplicates = owned.filter(
    (process_) => process_.pgid !== ownedListener?.pgid,
  );

  if (ownedListener !== undefined) {
    return {
      kind: "owned",
      listener: ownedListener,
      duplicates,
      detail: `Arc voice runtime pid ${ownedListener.pid} is already serving port ${query.port}`,
    };
  }

  const groupedListener = listeners.find((process_) =>
    ownedGroups.has(process_.pgid),
  );
  if (groupedListener !== undefined) {
    return {
      kind: "owned",
      listener: undefined,
      duplicates: owned,
      detail: `port ${query.port} is held by pid ${groupedListener.pid} inside an Arc voice process group that Arc cannot verify process by process`,
    };
  }

  const foreign = listeners[0];
  if (foreign !== undefined) {
    return {
      kind: "foreign",
      listener: foreign,
      duplicates,
      detail: `port ${query.port} is held by pid ${foreign.pid}, which is not an Arc voice process`,
    };
  }

  if (owned.length === 0) {
    return {
      kind: "vacant",
      detail: `nothing is serving port ${query.port}`,
    };
  }

  return {
    kind: "owned",
    listener: undefined,
    duplicates: owned,
    detail: `${owned.length} Arc voice process(es) survive without serving port ${query.port}`,
  };
}

export interface ReadArcVoiceListingArgs {
  platform?: NodeJS.Platform;
}

function readArcVoiceProcessListing(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const ps = resolvePosixTool("ps");
    if (ps === null) {
      reject(new Error("ps is not available"));
      return;
    }
    execFile(
      ps,
      [...PS_LISTING_ARGS],
      { encoding: "utf8", maxBuffer: LISTING_MAX_BYTES },
      (error, stdout) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        reject(error);
      },
    );
  });
}

function readLoopbackListeners(port: number): Promise<readonly number[]> {
  return new Promise<readonly number[]>((resolve, reject) => {
    const lsof = resolvePosixTool("lsof");
    if (lsof === null) {
      reject(new Error("lsof is not available"));
      return;
    }
    execFile(
      lsof,
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" },
      (error, stdout) => {
        if (error !== null && exitStatusOf(error) !== 1) {
          reject(error);
          return;
        }
        resolve([
          ...new Set(
            stdout
              .split("\n")
              .map((line) => Number(line.trim()))
              .filter((pid) => Number.isInteger(pid) && pid > 0),
          ),
        ]);
      },
    );
  });
}

export interface CreatePosixArcVoiceOwnershipProbeArgs {
  platform?: NodeJS.Platform;
  readProcessListing?: () => Promise<string>;
  readPortListeners?: (port: number) => Promise<readonly number[]>;
}

export function createPosixArcVoiceOwnershipProbe(
  args: CreatePosixArcVoiceOwnershipProbeArgs = {},
): ArcVoiceOwnershipProbe {
  const platform = args.platform ?? process.platform;
  const readProcesses = args.readProcessListing ?? readArcVoiceProcessListing;
  const readListeners = args.readPortListeners ?? readLoopbackListeners;
  return {
    async probe(query) {
      if (platform !== "darwin" && platform !== "linux") {
        return {
          kind: "unsupported",
          detail: `Arc cannot verify process ownership on ${platform}`,
        };
      }
      let listing: string;
      try {
        listing = await readProcesses();
      } catch (error) {
        return {
          kind: "unsupported",
          detail: `Arc could not list processes: ${errorMessage(error)}`,
        };
      }
      let listenerPids: readonly number[];
      try {
        listenerPids = await readListeners(query.port);
      } catch (error) {
        return {
          kind: "unsupported",
          detail: `Arc could not inspect port ${query.port}: ${errorMessage(error)}`,
        };
      }
      return classifyArcVoiceOwnership({
        fingerprints: parseArcVoiceProcessListing(listing),
        listenerPids: new Set(listenerPids),
        query,
      });
    },
  };
}

export interface CreateAdoptedArcVoiceProcessArgs {
  fingerprint: ArcVoiceProcessFingerprint;
  query: ArcVoiceOwnershipQuery;
  lookupProcess?: (pid: number) => ArcVoiceProcessLookup;
  lookupProcessAsync?: (pid: number) => Promise<ArcVoiceProcessLookup>;
  readOwnProcessGroupId?: () => number | null;
  signalProcess?: (target: number, signal: NodeJS.Signals) => boolean;
  pollIntervalMs?: number;
}

export function createAdoptedArcVoiceProcess(
  args: CreateAdoptedArcVoiceProcessArgs,
): ArcVoiceAdoptedProcess {
  const { fingerprint, query } = args;
  const lookup = args.lookupProcess ?? lookupArcVoiceProcessSync;
  const lookupAsync = args.lookupProcessAsync ?? lookupArcVoiceProcess;
  const readOwnGroup =
    args.readOwnProcessGroupId ??
    (() => {
      const own = lookupArcVoiceProcessSync(process.pid);
      return own.kind === "found" ? own.fingerprint.pgid : null;
    });
  const signalProcess =
    args.signalProcess ??
    ((target: number, signal: NodeJS.Signals) => process.kill(target, signal));
  const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const closeListeners: ((
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void)[] = [];
  let held = true;
  let closed = false;
  let poller: NodeJS.Timeout | null = null;
  let ownGroupId: number | null | undefined;

  const stopPolling = (): void => {
    if (poller !== null) {
      clearInterval(poller);
      poller = null;
    }
  };

  const fireClosed = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    held = false;
    stopPolling();
    for (const listener of closeListeners) {
      listener(null, null);
    }
  };

  const identityState = (): "held" | "lost" | "unknown" => {
    const current = lookup(fingerprint.pid);
    if (current.kind === "gone") {
      return "lost";
    }
    if (current.kind === "unknown") {
      return "unknown";
    }
    if (
      current.fingerprint.startedAt !== fingerprint.startedAt ||
      !isArcVoiceboxProcess(current.fingerprint, query)
    ) {
      return "lost";
    }
    return "held";
  };

  const ownGroupValue = (): number | null => {
    if (ownGroupId === undefined) {
      ownGroupId = readOwnGroup();
    }
    return ownGroupId;
  };

  const signalGroup = (
    groupId: number,
    signal: NodeJS.Signals,
  ): boolean => {
    if (groupId <= 1 || groupId === process.pid) {
      return false;
    }
    const ownGroup = ownGroupValue();
    if (ownGroup === null || groupId === ownGroup) {
      return false;
    }
    const leader = lookup(groupId);
    if (
      leader.kind !== "found" ||
      !isGroupLeader(leader.fingerprint) ||
      !isArcVoiceboxProcess(leader.fingerprint, query)
    ) {
      return false;
    }
    try {
      return signalProcess(-groupId, signal);
    } catch {
      return false;
    }
  };

  const signalVerified = (signal: NodeJS.Signals): boolean => {
    if (closed) {
      return false;
    }
    const state = identityState();
    if (state === "lost") {
      fireClosed();
      return false;
    }
    if (state === "unknown") {
      return false;
    }
    if (signalGroup(fingerprint.pgid, signal)) {
      return true;
    }
    if (fingerprint.pid === fingerprint.pgid) {
      return false;
    }
    try {
      return signalProcess(fingerprint.pid, signal);
    } catch {
      return false;
    }
  };

  const startPolling = (): void => {
    if (poller !== null || closed) {
      return;
    }
    poller = setInterval(() => {
      if (closed) {
        return;
      }
      void lookupAsync(fingerprint.pid)
        .then((current) => {
          if (closed) {
            return;
          }
          if (current.kind === "gone") {
            fireClosed();
            return;
          }
          if (current.kind === "found") {
            held =
              current.fingerprint.startedAt === fingerprint.startedAt &&
              isArcVoiceboxProcess(current.fingerprint, query);
            if (!held) {
              fireClosed();
            }
          }
        })
        .catch(() => undefined);
    }, pollIntervalMs);
    poller.unref();
  };

  return {
    pid: fingerprint.pid,
    kill: (signal) => signalVerified(signal),
    killResidualTree: () => {
      if (signalGroup(fingerprint.pgid, "SIGKILL")) {
        return true;
      }
      if (closed) {
        return false;
      }
      return signalVerified("SIGKILL");
    },
    hasExited: () => {
      if (closed) {
        return true;
      }
      const state = identityState();
      if (state === "held") {
        return false;
      }
      if (state === "unknown") {
        return !held;
      }
      fireClosed();
      return true;
    },
    onError: () => {},
    onClose: (listener) => {
      closeListeners.push(listener);
      startPolling();
    },
    dispose: () => {
      closed = true;
      stopPolling();
    },
  };
}
