import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SNAPSHOT_DIR_MODE = 0o700;
const SNAPSHOT_FILE_MODE = 0o600;

export function resolveCodexShellSnapshotDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const codexHome = env.CODEX_HOME?.trim();
  const home =
    codexHome !== undefined && codexHome.length > 0
      ? codexHome
      : join(homedir(), ".codex");
  return join(home, "shell_snapshots");
}

export function hardenCodexShellSnapshotDir(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = resolveCodexShellSnapshotDir(env);
  try {
    mkdirSync(dir, { recursive: true, mode: SNAPSHOT_DIR_MODE });
    if ((statSync(dir).mode & 0o777) !== SNAPSHOT_DIR_MODE) {
      chmodSync(dir, SNAPSHOT_DIR_MODE);
    }
    for (const name of readdirSync(dir)) {
      const entryPath = join(dir, name);
      const entryStat = statSync(entryPath);
      if (
        entryStat.isFile() &&
        (entryStat.mode & 0o777) !== SNAPSHOT_FILE_MODE
      ) {
        chmodSync(entryPath, SNAPSHOT_FILE_MODE);
      }
    }
  } catch {
    return;
  }
}
