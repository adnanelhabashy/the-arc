import type { Account, PoolProvider } from "./contracts.js";

// The stable, canonical identity threads.accountKey stores
// (`openai:chatgpt:<codexAccountId>` / `anthropic:account:<accountUuid>`),
// built from a provider-issued id that survives a reconnect creating a new
// pool row for the same real account — never the pool's own row id, which a
// reconnect changes. Kept in one place because both directions (assigning a
// key to an account, and resolving a key back to a live row) must agree on
// the exact same prefixes or the two can silently drift apart.
function prefixFor(provider: PoolProvider): string {
  return provider === "codex" ? "openai:chatgpt:" : "anthropic:account:";
}

export function accountKeyFor(account: Account): string | null {
  const prefix = prefixFor(account.provider);
  const providerIssuedId =
    account.provider === "codex" ? account.codexAccountId : account.accountUuid;
  if (providerIssuedId === undefined || providerIssuedId === null) return null;
  return `${prefix}${providerIssuedId}`;
}

export async function resolvePoolAccountId(
  accounts: Pick<import("./store.js").AccountStore, "list">,
  provider: PoolProvider,
  accountKey: string,
): Promise<string | null> {
  const prefix = prefixFor(provider);
  if (!accountKey.startsWith(prefix)) return null;
  const providerIssuedId = accountKey.slice(prefix.length);
  if (providerIssuedId.length === 0) return null;
  const match = (await accounts.list()).find((candidate: Account) => {
    if (candidate.provider !== provider) return false;
    return provider === "codex"
      ? candidate.codexAccountId === providerIssuedId
      : candidate.accountUuid === providerIssuedId;
  });
  return match?.id ?? null;
}
