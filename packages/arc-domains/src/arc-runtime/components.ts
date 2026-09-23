import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { sha256File } from "./digest.js";

export interface ArcRuntimeComponentExpectation {
  fileName: string;
  /** Digest the file must have, or null when no digest was ever recorded. */
  expectedDigest: string | null;
}

export interface ArcRuntimeComponentCheck {
  fileName: string;
  path: string;
  ok: boolean;
  detail: string;
}

export interface CheckArcRuntimeComponentsArgs {
  expectations: readonly ArcRuntimeComponentExpectation[];
  /** Absolute path of a companion, inside its version directory. */
  componentPath: (fileName: string) => string;
  isWindows: boolean;
  /**
   * Compare the on-disk digest with the expectation. Off for the routine
   * startup path, where re-reading a ~62 MB helper on every launch is a real
   * cost for a file nothing could have replaced; on for the explicit
   * prepare/repair/update path, where the whole point is to prove provenance.
   */
  verifyDigest: boolean;
}

/**
 * Checks that every required companion is present, executable, and — when
 * asked — byte-identical to what was verified at install time.
 *
 * Existence alone is not enough: a helper that cannot be executed, or that has
 * been replaced, produces a runtime that starts and then fails on first use,
 * which is the half-working session Arc must never expose.
 */
export async function checkArcRuntimeComponents(
  args: CheckArcRuntimeComponentsArgs,
): Promise<ArcRuntimeComponentCheck[]> {
  const checks: ArcRuntimeComponentCheck[] = [];
  for (const expectation of args.expectations) {
    const path = args.componentPath(expectation.fileName);
    checks.push(await checkComponent(args, expectation, path));
  }
  return checks;
}

async function checkComponent(
  args: CheckArcRuntimeComponentsArgs,
  expectation: ArcRuntimeComponentExpectation,
  path: string,
): Promise<ArcRuntimeComponentCheck> {
  const reject = (detail: string): ArcRuntimeComponentCheck => ({
    fileName: expectation.fileName,
    path,
    ok: false,
    detail,
  });

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(path);
  } catch {
    return reject(`${expectation.fileName} is missing at ${path}`);
  }
  if (!fileStat.isFile()) {
    return reject(`${expectation.fileName} at ${path} is not a regular file`);
  }
  if (!args.isWindows) {
    try {
      await access(path, constants.X_OK);
    } catch {
      return reject(`${expectation.fileName} at ${path} is not executable`);
    }
  }
  if (args.verifyDigest && expectation.expectedDigest !== null) {
    const digest = await sha256File(path).catch(() => null);
    if (digest !== expectation.expectedDigest) {
      return reject(
        `${expectation.fileName} digest is ${digest ?? "unreadable"}, expected ${expectation.expectedDigest}`,
      );
    }
  }
  return {
    fileName: expectation.fileName,
    path,
    ok: true,
    detail: `${expectation.fileName} verified at ${path}`,
  };
}
