import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { createConnection } from "@bb/db";
import { isSensitiveEnvName } from "@bb/domain";
import {
  resolveDataDirDatabasePath,
  resolveRuntimeDataDir,
  resolveRuntimeMode,
} from "@bb/config/runtime";
import { bold, dim, green, log, yellow } from "../lib/script-helpers.js";
import { runMainIfEntrypoint } from "../lib/script-entry.js";
import { resolveDevDataDir } from "../lib/dev-restart-utils.js";

interface EnvironmentEntry {
  name?: unknown;
  value?: unknown;
  [key: string]: unknown;
}

interface RedactionOutcome {
  rowsScanned: number;
  rowsChanged: number;
  entriesRedacted: number;
  names: Record<string, number>;
}

export function redactEnvResolvedRow(data: string): {
  changed: boolean;
  data: string;
  names: string[];
} {
  let event: { entries?: unknown };
  try {
    event = JSON.parse(data) as { entries?: unknown };
  } catch {
    return { changed: false, data, names: [] };
  }
  if (!Array.isArray(event.entries)) return { changed: false, data, names: [] };
  const names: string[] = [];
  const entries = event.entries.map((raw): unknown => {
    if (raw === null || typeof raw !== "object") return raw;
    const entry = raw as EnvironmentEntry;
    if (typeof entry.name !== "string") return raw;
    if (typeof entry.value !== "string") return raw;
    if (!isSensitiveEnvName(entry.name)) return raw;
    names.push(entry.name);
    return { ...entry, value: { masked: true } };
  });
  if (names.length === 0) return { changed: false, data, names };
  return {
    changed: true,
    data: JSON.stringify({ ...event, entries }),
    names,
  };
}

export function renderHelpText(): string {
  return `
  ${bold("bb redact-stored-env-secrets")}

  ${dim("Usage")}
    pnpm redact-stored-env-secrets -- [--apply] [--data-dir <path>]

  ${dim("Options")}
    --apply             Rewrite the affected rows (omit for a dry run)
    --data-dir <path>   Target a specific data directory instead of the resolved one

  ${dim("Notes")}
    Rewrites ${dim("provider.env-resolved")} events so credential-shaped environment
    values are stored as masked instead of verbatim. Event identity, names,
    sources and ordering are unchanged. Values are never printed.
\n`;
}

function resolveArgs(argv: string[]): { apply: boolean; dataDir: string } {
  const apply = argv.includes("--apply");
  const flagIndex = argv.indexOf("--data-dir");
  const rawDataDir = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  if (flagIndex !== -1 && rawDataDir === undefined) {
    throw new Error("--data-dir requires a path");
  }
  if (rawDataDir !== undefined) {
    const resolved = resolve(rawDataDir);
    if (!isAbsolute(resolved)) {
      throw new Error(`Refusing non-absolute data directory: ${rawDataDir}`);
    }
    return { apply, dataDir: resolved };
  }
  const mode = resolveRuntimeMode(process.env.NODE_ENV);
  return {
    apply,
    dataDir:
      mode === "dev"
        ? resolveDevDataDir()
        : resolveRuntimeDataDir({
            env: process.env,
            homeDir: homedir(),
            mode,
          }),
  };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(renderHelpText());
    return;
  }
  const { apply, dataDir } = resolveArgs(argv);
  const databasePath = resolveDataDirDatabasePath({ dataDir });
  process.stdout.write(`\n  ${bold("bb redact-stored-env-secrets")}\n\n`);
  log(dim("›"), `Data directory: ${dim(dataDir)}`);
  log(dim("›"), apply ? yellow("Mode: apply") : dim("Mode: dry run"));

  const db = createConnection(databasePath);
  const rows = db.$client
    .prepare(
      "select id, data from events where type = 'provider.env-resolved' order by sequence",
    )
    .all() as Array<{ id: string; data: string }>;

  const outcome: RedactionOutcome = {
    rowsScanned: rows.length,
    rowsChanged: 0,
    entriesRedacted: 0,
    names: {},
  };
  const updates: Array<{ id: string; data: string }> = [];
  for (const row of rows) {
    const result = redactEnvResolvedRow(row.data);
    if (!result.changed) continue;
    outcome.rowsChanged += 1;
    outcome.entriesRedacted += result.names.length;
    for (const name of result.names) {
      outcome.names[name] = (outcome.names[name] ?? 0) + 1;
    }
    updates.push({ id: row.id, data: result.data });
  }

  if (apply && updates.length > 0) {
    const update = db.$client.prepare("update events set data = ? where id = ?");
    db.$client.transaction(() => {
      for (const entry of updates) update.run(entry.data, entry.id);
    })();
  }

  process.stdout.write("\n");
  log(" ", `Events scanned: ${outcome.rowsScanned}`);
  log(" ", `Events with credential values: ${outcome.rowsChanged}`);
  log(" ", `Entries ${apply ? "redacted" : "to redact"}: ${outcome.entriesRedacted}`);
  for (const [name, count] of Object.entries(outcome.names).sort()) {
    log(" ", dim(`${name}: ${count}`));
  }
  process.stdout.write("\n");
  log(
    green("●"),
    apply
      ? `Redacted ${outcome.entriesRedacted} stored values.`
      : "Dry run only. Re-run with --apply to rewrite these rows.",
  );
  process.stdout.write("\n");
}

runMainIfEntrypoint(import.meta.url, main);
