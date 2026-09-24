import { describe, expect, it, vi } from "vitest";
import {
  classifyArcVoiceOwnership,
  createAdoptedArcVoiceProcess,
  createPosixArcVoiceOwnershipProbe,
  isArcVoiceboxProcess,
  lookupArcVoiceProcessSync,
  parseArcVoiceProcessListing,
  type ArcVoiceOwnershipQuery,
  type ArcVoiceProcessFingerprint,
  type ArcVoiceProcessLookup,
} from "../src/ownership.js";

const executablePath =
  "/Users/adnan/Library/Application Support/Arc Agent/arc-runtimes/voicebox/active/voicebox-server";
const dataDir =
  "/Users/adnan/Library/Application Support/Arc Agent/voice/state/voicebox";
const query: ArcVoiceOwnershipQuery = { port: 47873, executablePath, dataDir };

const leaderPid = 37549;
const listenerPid = 37591;
const trackerPid = 38424;

const liveCommand = `${executablePath} --host 127.0.0.1 --port 47873 --data-dir ${dataDir} --parent-pid 37541`;

const LIVE_LISTING = [
  `${leaderPid}     1 ${leaderPid} Thu Sep 24 09:19:05 2026 ${liveCommand}`,
  `${listenerPid} ${leaderPid} ${leaderPid} Thu Sep 24 09:19:08 2026 ${liveCommand}`,
  `${trackerPid} ${listenerPid} ${leaderPid} Thu Sep 24 09:20:29 2026 ${executablePath} -B -S -I -c from multiprocessing.resource_tracker import main;main(20)`,
  "",
].join("\n");

function fingerprint(
  overrides: Partial<ArcVoiceProcessFingerprint> & { pid: number },
): ArcVoiceProcessFingerprint {
  const pid = overrides.pid;
  return {
    pid,
    ppid: overrides.ppid ?? 1,
    pgid: overrides.pgid ?? pid,
    startedAt: overrides.startedAt ?? "Thu Sep 24 09:19:05 2026",
    command: overrides.command ?? liveCommand,
  };
}

const leader = fingerprint({ pid: leaderPid, ppid: 1, pgid: leaderPid });
const listener = fingerprint({
  pid: listenerPid,
  ppid: leaderPid,
  pgid: leaderPid,
  startedAt: "Thu Sep 24 09:19:08 2026",
});
const tracker = fingerprint({
  pid: trackerPid,
  ppid: listenerPid,
  pgid: leaderPid,
  startedAt: "Thu Sep 24 09:20:29 2026",
  command: `${executablePath} -B -S -I -c from multiprocessing.resource_tracker import main;main(20)`,
});

describe("parseArcVoiceProcessListing", () => {
  it("parses the real ps listing shape, keeping spaced paths and the start token", () => {
    const parsed = parseArcVoiceProcessListing(LIVE_LISTING);

    expect(parsed).toEqual([leader, listener, tracker]);
    expect(parsed[1]?.command.startsWith(executablePath)).toBe(true);
    expect(parsed[1]?.startedAt).toBe("Thu Sep 24 09:19:08 2026");
  });

  it("skips lines that carry no usable identity", () => {
    const parsed = parseArcVoiceProcessListing(
      ["", "   ", "not-a-pid 1 1 Thu Sep 24 09:19:05 2026 /bin/sh", "12 3 4"].join(
        "\n",
      ),
    );

    expect(parsed).toEqual([]);
  });
});

describe("isArcVoiceboxProcess", () => {
  it("recognizes the runtime Arc spawned and the child that serves the port", () => {
    expect(isArcVoiceboxProcess(leader, query)).toBe(true);
    expect(isArcVoiceboxProcess(listener, query)).toBe(true);
  });

  it("rejects sibling processes that carry only part of the identity", () => {
    expect(isArcVoiceboxProcess(tracker, query)).toBe(false);
    expect(
      isArcVoiceboxProcess(
        fingerprint({
          pid: 900,
          command: `${executablePath} --host 127.0.0.1 --port 47874 --data-dir ${dataDir}`,
        }),
        query,
      ),
    ).toBe(false);
    expect(
      isArcVoiceboxProcess(
        fingerprint({
          pid: 901,
          command: `${executablePath} --host 127.0.0.1 --port 47873 --data-dir ${dataDir}-old`,
        }),
        query,
      ),
    ).toBe(false);
    expect(
      isArcVoiceboxProcess(
        fingerprint({
          pid: 902,
          command: `${executablePath} --host 127.0.0.1 --port 47873`,
        }),
        query,
      ),
    ).toBe(false);
  });

  it("rejects a foreign process that happens to mention the port", () => {
    expect(
      isArcVoiceboxProcess(
        fingerprint({
          pid: 903,
          command: "/usr/bin/python3 -m http.server --port 47873 --data-dir /tmp",
        }),
        query,
      ),
    ).toBe(false);
    expect(
      isArcVoiceboxProcess(
        fingerprint({
          pid: 904,
          command: `/bin/sh -c "exec ${executablePath} --port 47873 --data-dir ${dataDir}"`,
        }),
        query,
      ),
    ).toBe(false);
  });
});

describe("classifyArcVoiceOwnership", () => {
  it("reports a vacant port when nothing Arc-owned is running", () => {
    expect(
      classifyArcVoiceOwnership({
        fingerprints: [
          fingerprint({ pid: 700, command: "/usr/bin/python3 -m http.server" }),
        ],
        listenerPids: new Set(),
        query,
      }),
    ).toMatchObject({ kind: "vacant" });
  });

  it("recognizes an Arc-owned runtime through the child that serves the port", () => {
    const verdict = classifyArcVoiceOwnership({
      fingerprints: [leader, listener, tracker],
      listenerPids: new Set([listenerPid]),
      query,
    });

    expect(verdict.kind).toBe("owned");
    if (verdict.kind !== "owned") {
      return;
    }
    expect(verdict.listener?.pid).toBe(listenerPid);
    expect(verdict.duplicates).toEqual([]);
  });

  it("keeps a second Arc-owned runtime as a duplicate to clean up", () => {
    const stale = fingerprint({
      pid: 500,
      pgid: 500,
      startedAt: "Thu Sep 24 08:02:00 2026",
    });
    const verdict = classifyArcVoiceOwnership({
      fingerprints: [leader, listener, tracker, stale],
      listenerPids: new Set([listenerPid]),
      query,
    });

    expect(verdict.kind).toBe("owned");
    if (verdict.kind !== "owned") {
      return;
    }
    expect(verdict.duplicates).toEqual([stale]);
  });

  it("reports Arc-owned processes that no longer serve the port as cleanup targets", () => {
    const verdict = classifyArcVoiceOwnership({
      fingerprints: [leader, listener, tracker],
      listenerPids: new Set(),
      query,
    });

    expect(verdict.kind).toBe("owned");
    if (verdict.kind !== "owned") {
      return;
    }
    expect(verdict.listener).toBeUndefined();
    expect(verdict.duplicates).toEqual([leader, listener]);
  });

  it("never treats a foreign port holder as owned", () => {
    const foreign = fingerprint({
      pid: 812,
      pgid: 812,
      command: "/usr/bin/python3 -m http.server 47873",
    });
    const verdict = classifyArcVoiceOwnership({
      fingerprints: [foreign],
      listenerPids: new Set([812]),
      query,
    });

    expect(verdict.kind).toBe("foreign");
    if (verdict.kind !== "foreign") {
      return;
    }
    expect(verdict.listener.pid).toBe(812);
    expect(verdict.duplicates).toEqual([]);
  });

  it("refuses a foreign holder while still naming Arc's own leftovers", () => {
    const foreign = fingerprint({
      pid: 812,
      pgid: 812,
      command: "/usr/bin/python3 -m http.server 47873",
    });
    const verdict = classifyArcVoiceOwnership({
      fingerprints: [foreign, leader, listener],
      listenerPids: new Set([812]),
      query,
    });

    expect(verdict.kind).toBe("foreign");
    if (verdict.kind !== "foreign") {
      return;
    }
    expect(verdict.duplicates).toEqual([leader, listener]);
  });

  it("cleans up a listener Arc cannot verify process by process instead of adopting it", () => {
    const unverifiableListener = fingerprint({
      pid: 61500,
      ppid: listenerPid,
      pgid: leaderPid,
      startedAt: "Thu Sep 24 09:21:00 2026",
      command: `${executablePath} -c from multiprocessing.spawn import spawn_main`,
    });
    const verdict = classifyArcVoiceOwnership({
      fingerprints: [leader, listener, unverifiableListener],
      listenerPids: new Set([61500]),
      query,
    });

    expect(verdict.kind).toBe("owned");
    if (verdict.kind !== "owned") {
      return;
    }
    expect(verdict.listener).toBeUndefined();
    expect(verdict.duplicates).toEqual([leader, listener]);
  });
});

describe("createPosixArcVoiceOwnershipProbe", () => {
  it("classifies through the injected process listing and listener list", async () => {
    const probe = createPosixArcVoiceOwnershipProbe({
      platform: "darwin",
      readProcessListing: () => Promise.resolve(LIVE_LISTING),
      readPortListeners: () => Promise.resolve([listenerPid]),
    });

    await expect(probe.probe(query)).resolves.toMatchObject({
      kind: "owned",
      listener: { pid: listenerPid },
    });
  });

  it("reports an unsupported platform instead of guessing ownership", async () => {
    const probe = createPosixArcVoiceOwnershipProbe({ platform: "win32" });

    await expect(probe.probe(query)).resolves.toMatchObject({
      kind: "unsupported",
    });
  });

  it("reports an unsupported probe when process or port inspection fails", async () => {
    const listingFailure = createPosixArcVoiceOwnershipProbe({
      platform: "darwin",
      readProcessListing: () => Promise.reject(new Error("ps is missing")),
      readPortListeners: () => Promise.resolve([]),
    });
    const listenerFailure = createPosixArcVoiceOwnershipProbe({
      platform: "darwin",
      readProcessListing: () => Promise.resolve(LIVE_LISTING),
      readPortListeners: () => Promise.reject(new Error("lsof is missing")),
    });

    await expect(listingFailure.probe(query)).resolves.toMatchObject({
      kind: "unsupported",
    });
    await expect(listenerFailure.probe(query)).resolves.toMatchObject({
      kind: "unsupported",
    });
  });

  it("reaches the real process table without ever signalling a process", async () => {
    const signalSpy = vi.spyOn(process, "kill");
    const probe = createPosixArcVoiceOwnershipProbe();

    const verdict = await probe.probe({
      port: 1,
      executablePath: "/nonexistent/arc-voicebox",
      dataDir: "/nonexistent/arc-voice-state",
    });

    expect(verdict.kind).toBe("vacant");
    expect(signalSpy).not.toHaveBeenCalled();
    signalSpy.mockRestore();
  });
});

describe("createAdoptedArcVoiceProcess", () => {
  function found(
    value: ArcVoiceProcessFingerprint,
  ): ArcVoiceProcessLookup {
    return { kind: "found", fingerprint: value };
  }

  function adoptedArgs(overrides?: {
    lookup?: (pid: number) => ArcVoiceProcessLookup;
    lookupAsync?: (pid: number) => Promise<ArcVoiceProcessLookup>;
    ownGroupId?: number | null;
    signals?: { target: number; signal: NodeJS.Signals }[];
  }) {
    const signals = overrides?.signals ?? [];
    const lookup =
      overrides?.lookup ??
      ((pid: number) =>
        pid === leaderPid
          ? found(leader)
          : pid === listenerPid
            ? found(listener)
            : { kind: "gone" as const });
    return {
      signals,
      args: {
        fingerprint: listener,
        query,
        lookupProcess: lookup,
        lookupProcessAsync: overrides?.lookupAsync ?? (() => Promise.resolve(lookup(listener.pid))),
        readOwnProcessGroupId: () =>
          overrides?.ownGroupId === undefined ? 4242 : overrides.ownGroupId,
        signalProcess: (target: number, signal: NodeJS.Signals) => {
          signals.push({ target, signal });
          return true;
        },
        pollIntervalMs: 20,
      },
    };
  }

  it("signals the runtime's process group so the whole tree dies", () => {
    const { args, signals } = adoptedArgs();
    const process_ = createAdoptedArcVoiceProcess(args);

    expect(process_.pid).toBe(listenerPid);
    expect(process_.kill("SIGTERM")).toBe(true);
    expect(process_.killResidualTree()).toBe(true);
    expect(signals).toEqual([
      { target: -leaderPid, signal: "SIGTERM" },
      { target: -leaderPid, signal: "SIGKILL" },
    ]);
  });

  it("falls back to the single process when the group is Arc's own group", () => {
    const { args, signals } = adoptedArgs({ ownGroupId: leaderPid });
    const process_ = createAdoptedArcVoiceProcess(args);

    expect(process_.kill("SIGTERM")).toBe(true);
    expect(signals).toEqual([{ target: listenerPid, signal: "SIGTERM" }]);
  });

  it("signals only the process when the own group cannot be established", () => {
    const { args, signals } = adoptedArgs({ ownGroupId: null });
    const process_ = createAdoptedArcVoiceProcess(args);

    expect(process_.kill("SIGTERM")).toBe(true);
    expect(signals).toEqual([{ target: listenerPid, signal: "SIGTERM" }]);
  });

  it("refuses to signal a group whose leader is not the Arc voice runtime", () => {
    const { args, signals } = adoptedArgs({
      lookup: (pid) =>
        pid === listenerPid
          ? found(listener)
          : found(
              fingerprint({
                pid: leaderPid,
                pgid: leaderPid,
                command: "/usr/bin/python3 -m http.server 47873",
              }),
            ),
    });
    const process_ = createAdoptedArcVoiceProcess(args);

    expect(process_.kill("SIGTERM")).toBe(true);
    expect(signals).toEqual([{ target: listenerPid, signal: "SIGTERM" }]);
  });

  it("refuses to signal a pid that no longer holds the recorded identity", () => {
    const { args, signals } = adoptedArgs({
      lookup: () =>
        found(
          fingerprint({
            pid: listenerPid,
            startedAt: "Fri Sep 25 11:00:00 2026",
          }),
        ),
    });
    const process_ = createAdoptedArcVoiceProcess(args);

    expect(process_.kill("SIGTERM")).toBe(false);
    expect(process_.killResidualTree()).toBe(true);
    expect(signals).toEqual([{ target: -leaderPid, signal: "SIGKILL" }]);
  });

  it("refuses to signal a pid that no longer runs the Arc-owned runtime", () => {
    const { args, signals } = adoptedArgs({
      lookup: () =>
        found(
          fingerprint({
            pid: listenerPid,
            command: "/usr/bin/python3 -m http.server 47873",
          }),
        ),
    });
    const process_ = createAdoptedArcVoiceProcess(args);

    expect(process_.kill("SIGKILL")).toBe(false);
    expect(signals).toEqual([]);
  });

  it("reports the runtime as exited once its identity is gone", () => {
    const { args, signals } = adoptedArgs({ lookup: () => ({ kind: "gone" }) });
    const process_ = createAdoptedArcVoiceProcess(args);
    const closed = vi.fn();
    process_.onClose(closed);

    expect(process_.hasExited()).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(process_.kill("SIGTERM")).toBe(false);
    expect(signals).toEqual([]);
  });

  it("never treats an unreadable process table as an exited runtime", () => {
    const { args, signals } = adoptedArgs({
      lookup: () => ({ kind: "unknown", detail: "ps failed" }),
    });
    const process_ = createAdoptedArcVoiceProcess(args);
    const closed = vi.fn();
    process_.onClose(closed);

    expect(process_.hasExited()).toBe(false);
    expect(process_.kill("SIGTERM")).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(signals).toEqual([]);

    process_.dispose();
  });

  it("still force-kills the group after the port process has exited", () => {
    const { args, signals } = adoptedArgs({
      lookup: (pid) =>
        pid === leaderPid ? found(leader) : { kind: "gone" },
    });
    const process_ = createAdoptedArcVoiceProcess(args);

    expect(process_.kill("SIGTERM")).toBe(false);
    expect(process_.killResidualTree()).toBe(true);
    expect(signals).toEqual([{ target: -leaderPid, signal: "SIGKILL" }]);
  });

  it("notices a vanished runtime while it is only being watched", async () => {
    vi.useFakeTimers();
    try {
      let current: ArcVoiceProcessLookup = found(listener);
      const { args } = adoptedArgs({
        lookup: () => current,
        lookupAsync: () => Promise.resolve(current),
      });
      const process_ = createAdoptedArcVoiceProcess(args);
      const closed = vi.fn();
      process_.onClose(closed);

      await vi.advanceTimersByTimeAsync(60);
      expect(closed).not.toHaveBeenCalled();

      current = { kind: "gone" };
      await vi.advanceTimersByTimeAsync(60);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(process_.hasExited()).toBe(true);

      process_.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps watching when the asynchronous read cannot answer", async () => {
    vi.useFakeTimers();
    try {
      const { args } = adoptedArgs({
        lookupAsync: () => Promise.resolve({ kind: "unknown", detail: "ps failed" }),
      });
      const process_ = createAdoptedArcVoiceProcess(args);
      const closed = vi.fn();
      process_.onClose(closed);

      await vi.advanceTimersByTimeAsync(100);

      expect(closed).not.toHaveBeenCalled();
      expect(process_.hasExited()).toBe(false);

      process_.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops signalling once the adopted handle is disposed", () => {
    const { args, signals } = adoptedArgs();
    const process_ = createAdoptedArcVoiceProcess(args);
    process_.dispose();

    expect(process_.kill("SIGTERM")).toBe(false);
    expect(signals).toEqual([]);
  });
});

describe("lookupArcVoiceProcessSync", () => {
  it("reads this process and reports a missing pid as gone", () => {
    const self = lookupArcVoiceProcessSync(process.pid);

    expect(self.kind).toBe("found");
    expect(self.kind === "found" ? self.fingerprint.pid : null).toBe(
      process.pid,
    );
    expect(self.kind === "found" ? self.fingerprint.command.length : 0).toBeGreaterThan(0);
    expect(lookupArcVoiceProcessSync(999_999)).toEqual({ kind: "gone" });
  });
});
