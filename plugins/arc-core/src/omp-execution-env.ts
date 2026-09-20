import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ompAccountPoolFileContent,
  OMP_ACCOUNT_POOL_FILE_ENV,
  OMP_BROKER_TOKEN_ENV,
  OMP_BROKER_URL_ENV,
  resolveArcOmpExecutionPin,
  type ArcAccount,
  type ArcOmpBrokerConnection,
  type ArcOmpExecutionPin,
} from "@bb/arc-domains/arc-account";
import type { ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";

export interface ArcOmpExecutionEnvArgs {
  accountKey: string | null;
  accounts: readonly ArcAccount[];
  poolFileDirectory: string;
  holdBroker: () => Promise<ArcOmpBrokerConnection>;
}

export interface ArcOmpExecutionEnvResult {
  entries: ExperimentalPluginProviderEnvEntry[];
  pin: ArcOmpExecutionPin;
}

export async function resolveArcOmpExecutionEnv(
  args: ArcOmpExecutionEnvArgs,
): Promise<ArcOmpExecutionEnvResult> {
  const pin = resolveArcOmpExecutionPin({
    accounts: args.accounts,
    accountKey: args.accountKey,
  });
  const content = ompAccountPoolFileContent({
    pin,
    knownProviders: [
      ...new Set(args.accounts.map((account) => account.providerFamily)),
    ],
  });
  if (content === null) return { entries: [], pin };
  const poolFilePath = await writeAccountPoolFile(
    args.poolFileDirectory,
    `${JSON.stringify(content, null, 2)}\n`,
  );
  const broker = await args.holdBroker();
  return {
    pin,
    entries: [
      {
        name: OMP_BROKER_URL_ENV,
        value: broker.url,
        reason: "OMP account credentials come from Arc's loopback broker",
      },
      {
        name: OMP_BROKER_TOKEN_ENV,
        value: broker.token,
        reason: "Bearer token for Arc's OMP broker on this machine",
      },
      {
        name: OMP_ACCOUNT_POOL_FILE_ENV,
        value: poolFilePath,
        reason:
          pin.kind === "pinned"
            ? "Restricts this OMP execution to the thread's account"
            : "Excludes every stored OMP account: the thread's own is unavailable",
      },
    ],
  };
}

// Reported for the outcomes a user cannot see in the UI: a thread pinned to an
// OMP account that is no longer stored runs with no eligible OAuth credential
// (OMP reports the provider as unauthenticated) rather than on a different
// account, and a thread pinned to a non-OMP account is excluded the same way.
export function describeArcOmpExecutionPin(
  pin: ArcOmpExecutionPin,
): string | null {
  if (pin.kind === "unavailable") {
    return `thread account is not a stored ${pin.provider} account in OMP; running with no ${pin.provider} OAuth credential instead of a different account`;
  }
  if (pin.kind === "not-omp-account") {
    return "thread account is not an OMP account; running with no OMP OAuth credential instead of a different account";
  }
  return null;
}

// Content-addressed so the same pin reuses one file across threads and turns
// and a changed pin never rewrites a file another live execution is reading.
async function writeAccountPoolFile(
  directory: string,
  contents: string,
): Promise<string> {
  const digest = createHash("sha256")
    .update(contents)
    .digest("hex")
    .slice(0, 16);
  const filePath = path.join(directory, `${digest}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, contents, { mode: 0o600 });
  return filePath;
}
