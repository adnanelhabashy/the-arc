import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";

const DATA_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

export interface HardenLocalDataPermissionsArgs {
  dataDir: string;
  databasePath: string;
}

export interface LocalDataPermissionFailure {
  target: string;
  code: string;
}

export interface LocalDataPermissionReport {
  hardened: string[];
  failed: LocalDataPermissionFailure[];
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : "unknown";
}

function applyMode(path: string, mode: number): "changed" | "ok" | string {
  try {
    if ((statSync(path).mode & 0o777) === mode) return "ok";
    chmodSync(path, mode);
    return "changed";
  } catch (error) {
    return errorCode(error);
  }
}

function restrictTarget(
  path: string,
  mode: number,
  label: string,
  report: LocalDataPermissionReport,
): void {
  if (!existsSync(path)) return;
  const outcome = applyMode(path, mode);
  if (outcome === "changed") {
    report.hardened.push(label);
    return;
  }
  if (outcome === "ok") return;
  report.failed.push({ target: label, code: outcome });
}

export function hardenLocalDataPermissions(
  args: HardenLocalDataPermissionsArgs,
): LocalDataPermissionReport {
  const report: LocalDataPermissionReport = { hardened: [], failed: [] };
  try {
    mkdirSync(args.dataDir, { recursive: true, mode: DATA_DIR_MODE });
  } catch (error) {
    report.failed.push({ target: "data-dir", code: errorCode(error) });
    return report;
  }
  restrictTarget(args.dataDir, DATA_DIR_MODE, "data-dir", report);
  restrictTarget(args.databasePath, PRIVATE_FILE_MODE, "database", report);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    restrictTarget(
      `${args.databasePath}${suffix}`,
      PRIVATE_FILE_MODE,
      `database${suffix}`,
      report,
    );
  }
  return report;
}
