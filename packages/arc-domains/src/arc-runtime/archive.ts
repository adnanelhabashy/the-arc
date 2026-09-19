import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export type ArcRuntimeArchiveValidation =
  | { kind: "ok"; entryName: string }
  | { kind: "rejected"; reason: string };

export interface InspectArcRuntimeArchiveArgs {
  archivePath: string;
}

export interface ExtractArcRuntimeExecutableArgs {
  archivePath: string;
  destinationDir: string;
  expectedFileName: string;
}

const TAR_LIST_TIMEOUT_MS = 60_000;
const TAR_EXTRACT_TIMEOUT_MS = 120_000;

function listTarEntries(archivePath: string): Promise<string[]> {
  return new Promise<string[]>((resolvePromise, rejectPromise) => {
    execFile(
      "tar",
      ["-tzf", archivePath],
      { timeout: TAR_LIST_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(new Error(`tar listing failed: ${error.message}`));
          return;
        }
        resolvePromise(
          stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        );
      },
    );
  });
}

function entryIsSafeFileName(entry: string): boolean {
  return (
    entry.length > 0 &&
    !entry.startsWith("/") &&
    !entry.includes("\\") &&
    !entry.includes("/") &&
    !entry.split("/").includes("..") &&
    entry !== "." &&
    entry !== ".." &&
    /^[\w.+@-]+$/.test(entry)
  );
}

export async function inspectArcRuntimeArchive(
  args: InspectArcRuntimeArchiveArgs,
): Promise<ArcRuntimeArchiveValidation> {
  let entries: string[];
  try {
    entries = await listTarEntries(args.archivePath);
  } catch (error) {
    return {
      kind: "rejected",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (entries.length !== 1) {
    return {
      kind: "rejected",
      reason: `archive must contain exactly one entry, found ${entries.length}`,
    };
  }
  const [entry] = entries;
  if (!entryIsSafeFileName(entry)) {
    return {
      kind: "rejected",
      reason: `archive entry "${entry}" is not a plain relative file name`,
    };
  }
  return { kind: "ok", entryName: entry };
}

export async function extractArcRuntimeExecutable(
  args: ExtractArcRuntimeExecutableArgs,
): Promise<void> {
  const validation = await inspectArcRuntimeArchive({
    archivePath: args.archivePath,
  });
  if (validation.kind === "rejected") {
    throw new Error(`unsafe runtime archive: ${validation.reason}`);
  }
  if (validation.entryName !== args.expectedFileName) {
    throw new Error(
      `archive entry "${validation.entryName}" does not match expected executable name "${args.expectedFileName}"`,
    );
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      "tar",
      [
        "-xzf",
        args.archivePath,
        "-C",
        args.destinationDir,
        validation.entryName,
      ],
      { timeout: TAR_EXTRACT_TIMEOUT_MS },
      (error) => {
        if (error !== null) {
          rejectPromise(new Error(`tar extraction failed: ${error.message}`));
          return;
        }
        resolvePromise();
      },
    );
  });

  const extractedPath = join(args.destinationDir, validation.entryName);
  const extractedStat = await lstat(extractedPath);
  if (!extractedStat.isFile()) {
    throw new Error(
      `archive entry "${validation.entryName}" is not a regular file`,
    );
  }
  const stagedEntries = await readdir(args.destinationDir);
  if (
    stagedEntries.length !== 1 ||
    stagedEntries[0] !== validation.entryName
  ) {
    throw new Error("extraction produced unexpected files");
  }
}
