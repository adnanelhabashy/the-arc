import { useMemo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountPicker } from "./AccountPicker";
import type { ArcAccount, ArcAccountsList } from "@/hooks/queries/arc-queries";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "pickers/Account Picker",
};

const ARC_ACCOUNTS_QUERY_KEY = "arcAccounts";

function makeAccount(overrides: Partial<ArcAccount>): ArcAccount {
  return {
    id: overrides.id ?? "acct_1",
    sourceId: overrides.sourceId ?? "pool_1",
    sourceKind: "pool",
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountKey: overrides.accountKey ?? "openai:chatgpt:1",
    email: "person@example.com",
    planLabel: "Plus",
    authState: "connected",
    enabled: true,
    availableThrough: ["codex"],
    observedAt: Date.now(),
    ...overrides,
  };
}

const TWO_CHATGPT_ACCOUNTS: ArcAccount[] = [
  makeAccount({
    id: "acct_personal",
    accountKey: "openai:chatgpt:personal",
    email: "personal@example.com",
    planLabel: "Plus",
  }),
  makeAccount({
    id: "acct_work",
    accountKey: "openai:chatgpt:work",
    email: "work@example.com",
    planLabel: "Team",
  }),
];

function StoryQueryProvider({
  accounts,
  children,
}: {
  accounts: readonly ArcAccount[];
  children: ReactNode;
}) {
  const queryClient = useMemo(() => {
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false, staleTime: Infinity } },
    });
    client.setQueryData<ArcAccountsList>([ARC_ACCOUNTS_QUERY_KEY], {
      accounts: [...accounts],
      sources: [{ kind: "pool", state: "ready", detail: null, checkedAt: Date.now() }],
    });
    return client;
  }, [accounts]);

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const noop = () => {};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="new thread, Auto default" hint="two connected ChatGPT accounts">
        <StoryQueryProvider accounts={TWO_CHATGPT_ACCOUNTS}>
          <AccountPicker agentId="codex" value={null} onChange={noop} onManageAccounts={noop} />
        </StoryQueryProvider>
      </StoryRow>

      <StoryRow label="new thread, explicit pick" hint="Work ChatGPT selected">
        <StoryQueryProvider accounts={TWO_CHATGPT_ACCOUNTS}>
          <AccountPicker
            agentId="codex"
            value="openai:chatgpt:work"
            onChange={noop}
            onManageAccounts={noop}
          />
        </StoryQueryProvider>
      </StoryRow>

      <StoryRow label="new thread, one disabled account" hint="expired sign-in shown, not selectable">
        <StoryQueryProvider
          accounts={[
            TWO_CHATGPT_ACCOUNTS[0]!,
            makeAccount({
              id: "acct_expired",
              accountKey: "openai:chatgpt:expired",
              email: "old@example.com",
              authState: "expired",
            }),
          ]}
        >
          <AccountPicker agentId="codex" value={null} onChange={noop} onManageAccounts={noop} />
        </StoryQueryProvider>
      </StoryRow>

      <StoryRow label="existing thread, resolved" hint="compact display, click Change to switch">
        <StoryQueryProvider accounts={TWO_CHATGPT_ACCOUNTS}>
          <AccountPicker
            agentId="codex"
            value="openai:chatgpt:personal"
            onChange={noop}
            onManageAccounts={noop}
            existingThreadState={{
              accountKey: "openai:chatgpt:personal",
              accountResolved: true,
              hasHistory: true,
            }}
          />
        </StoryQueryProvider>
      </StoryRow>

      <StoryRow label="existing thread, switching account" hint="explicit confirm required before it takes effect">
        <StoryQueryProvider accounts={TWO_CHATGPT_ACCOUNTS}>
          <AccountPicker
            agentId="codex"
            value="openai:chatgpt:personal"
            onChange={noop}
            onManageAccounts={noop}
            existingThreadState={{
              accountKey: "openai:chatgpt:personal",
              accountResolved: true,
              hasHistory: true,
            }}
          />
        </StoryQueryProvider>
      </StoryRow>

      <StoryRow
        label="existing thread, legacy / unknown"
        hint="predates account binding — blocks sending until resolved"
      >
        <StoryQueryProvider accounts={TWO_CHATGPT_ACCOUNTS}>
          <AccountPicker
            agentId="codex"
            value={null}
            onChange={noop}
            onManageAccounts={noop}
            existingThreadState={{
              accountKey: null,
              accountResolved: null,
              hasHistory: true,
            }}
          />
        </StoryQueryProvider>
      </StoryRow>

      <StoryRow
        label="existing thread, pinned account removed"
        hint="was using Work ChatGPT, no longer available — blocks sending"
      >
        <StoryQueryProvider accounts={[TWO_CHATGPT_ACCOUNTS[0]!]}>
          <AccountPicker
            agentId="codex"
            value="openai:chatgpt:work"
            onChange={noop}
            onManageAccounts={noop}
            existingThreadState={{
              accountKey: "openai:chatgpt:work",
              accountResolved: true,
              hasHistory: true,
            }}
          />
        </StoryQueryProvider>
      </StoryRow>

      <StoryRow label="no connected accounts" hint="agent selected, nothing to pick — Auto option omitted, no picker shown">
        <StoryQueryProvider accounts={[]}>
          <AccountPicker agentId="codex" value={null} onChange={noop} onManageAccounts={noop} />
        </StoryQueryProvider>
      </StoryRow>
    </StoryCard>
  );
}
