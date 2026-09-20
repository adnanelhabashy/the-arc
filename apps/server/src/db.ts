import { createConnection, ensurePersonalProject, migrate } from "@bb/db";
import type {
  DbConnection,
  MigrationWarningLogger,
  SlowDbQueryLogger,
} from "@bb/db";
import type { Logger } from "@bb/logger";
import { hardenLocalDataPermissions } from "@bb/config/local-data-permissions";
import {
  exportLegacyAutomationsForPluginImport,
  hasLegacyAutomationsToExport,
} from "./legacy-automations-export.js";

type InitDbLogger = MigrationWarningLogger &
  SlowDbQueryLogger &
  Pick<Logger, "error" | "info">;

interface InitDbOptions {
  dataDir?: string;
  logger?: InitDbLogger;
}

function hardenOwnedLocalData(
  databasePath: string,
  options: InitDbOptions,
): void {
  if (options.dataDir === undefined) return;
  const report = hardenLocalDataPermissions({
    dataDir: options.dataDir,
    databasePath,
  });
  if (report.hardened.length > 0) {
    options.logger?.info(
      `Restricted local data permissions (owner-only) for: ${report.hardened.join(", ")}.`,
    );
  }
  for (const failure of report.failed) {
    options.logger?.error(
      `Could not restrict ${failure.target} to owner-only permissions (${failure.code}).`,
    );
  }
}

export function initDb(
  databasePath: string,
  options: InitDbOptions = {},
): DbConnection {
  hardenOwnedLocalData(databasePath, options);
  const db = createConnection(databasePath, {
    slowQueryLogger: options.logger,
  });
  hardenOwnedLocalData(databasePath, options);
  if (options.dataDir !== undefined && options.logger !== undefined) {
    exportLegacyAutomationsForPluginImport({
      dataDir: options.dataDir,
      db,
      logger: options.logger,
    });
  } else if (hasLegacyAutomationsToExport(db)) {
    throw new Error(
      "Cannot migrate legacy automations without dataDir and logger; refusing to drop kernel automation rows before exporting them for the automations plugin",
    );
  }
  migrate(db, {
    deferDestructiveLegacyCleanup: true,
    logger: options.logger,
  });
  ensurePersonalProject(db);
  return db;
}
