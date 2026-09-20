import type { ArcAccount } from "./types.js";

// oh-my-pi resolves every stored credential through one auth broker, and its
// broker-mode client (RemoteAuthCredentialStore, verified in oh-my-pi v18.2.6
// packages/ai/src/auth-broker/remote-store.ts) filters OAuth credentials by a
// per-provider identity allowlist read from this file:
//
//   { "<omp provider id>": ["<credential identityKey>", ...] }
//
// A provider absent from the file stays unrestricted; an empty array excludes
// that provider's OAuth credentials entirely; api-key credentials are never
// filtered. The filter is client-side, so the provider process only obeys it
// while it talks to the broker (OMP_AUTH_BROKER_URL) instead of its local
// store — which is what turns one entry here into "this execution may only use
// this credential".
export const OMP_BROKER_URL_ENV = "OMP_AUTH_BROKER_URL";
export const OMP_BROKER_TOKEN_ENV = "OMP_AUTH_BROKER_TOKEN";
export const OMP_ACCOUNT_POOL_FILE_ENV = "OMP_AUTH_BROKER_ACCOUNT_POOL_FILE";

// OMP account keys are Arc's canonical identity (`omp:<provider>:<accountId>`,
// built by omp-account-source from the provider-issued account id). Parsing is
// deliberately independent of the account list: an unroutable key still names
// the provider it must fail closed for.
export type ArcOmpExecutionPin =
  | { kind: "unpinned" }
  | { kind: "pinned"; provider: string; identityKey: string }
  | { kind: "unavailable"; provider: string }
  | { kind: "not-omp-account" };

const OMP_ACCOUNT_KEY_PREFIX = "omp:";

export function parseArcOmpAccountKey(
  accountKey: string,
): { provider: string; accountId: string } | null {
  if (!accountKey.startsWith(OMP_ACCOUNT_KEY_PREFIX)) return null;
  const rest = accountKey.slice(OMP_ACCOUNT_KEY_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const provider = rest.slice(0, separator);
  const accountId = rest.slice(separator + 1);
  if (accountId.length === 0) return null;
  return { provider, accountId };
}

export function resolveArcOmpExecutionPin(args: {
  accounts: readonly ArcAccount[];
  accountKey: string | null;
}): ArcOmpExecutionPin {
  const { accountKey } = args;
  if (accountKey === null) return { kind: "unpinned" };
  const parsed = parseArcOmpAccountKey(accountKey);
  if (parsed === null) return { kind: "not-omp-account" };
  const account = args.accounts.find(
    (candidate) => candidate.accountKey === accountKey,
  );
  if (account === undefined || account.identityKey === null) {
    return { kind: "unavailable", provider: parsed.provider };
  }
  return {
    kind: "pinned",
    provider: parsed.provider,
    identityKey: account.identityKey,
  };
}

// null means "contribute no account-pool file": an unpinned (Auto) thread
// keeps OMP's own selection instead of having Arc narrow it. Every other
// outcome produces a file, including the two failure outcomes, so a thread
// bound to an account that cannot be used never silently runs on another one.
export function ompAccountPoolFileContent(args: {
  pin: ArcOmpExecutionPin;
  knownProviders: readonly string[];
}): Record<string, readonly string[]> | null {
  const { pin } = args;
  if (pin.kind === "unpinned") return null;
  if (pin.kind === "pinned") return { [pin.provider]: [pin.identityKey] };
  if (pin.kind === "unavailable") return { [pin.provider]: [] };
  return Object.fromEntries(
    [...args.knownProviders].sort().map((provider) => [provider, []]),
  );
}
