import { spawn } from "node:child_process";

export interface ArcVoiceProcessSpawnArgs {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ArcVoiceProcess {
  readonly pid: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
  killResidualTree(): boolean;
  hasExited(): boolean;
  onError(listener: (error: Error) => void): void;
  onClose(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

export interface ArcVoiceProcessSpawner {
  spawn(args: ArcVoiceProcessSpawnArgs): ArcVoiceProcess;
}

export function createNodeArcVoiceProcessSpawner(): ArcVoiceProcessSpawner {
  return {
    spawn(args) {
      const detached = process.platform !== "win32";
      const child = spawn(args.command, [...args.args], {
        env: args.env,
        cwd: args.cwd,
        stdio: "ignore",
        detached,
        windowsHide: true,
      });
      const hasExited = (): boolean =>
        child.exitCode !== null || child.signalCode !== null;
      const groupExists = (): boolean => {
        if (child.pid === undefined || !detached) {
          return false;
        }
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const signalGroup = (signal: NodeJS.Signals): boolean => {
        const pid = child.pid;
        if (pid === undefined || !detached || !groupExists()) {
          return false;
        }
        try {
          return process.kill(-pid, signal);
        } catch {
          return false;
        }
      };
      return {
        pid: child.pid,
        kill: (signal) => {
          if (hasExited()) {
            return false;
          }
          return signalGroup(signal) ? true : child.kill(signal);
        },
        killResidualTree: () => signalGroup("SIGKILL"),
        hasExited,
        onError: (listener) => {
          child.on("error", listener);
        },
        onClose: (listener) => {
          child.on("close", listener);
        },
      };
    },
  };
}
