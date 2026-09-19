// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArcAccount, ArcOmpProvider } from "@/lib/arc-types";

const mocks = vi.hoisted(() => ({
  useArcAccounts: vi.fn(),
  useArcOmpProviders: vi.fn(),
  useArcLogin: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  useArcAccounts: mocks.useArcAccounts,
  useArcOmpProviders: mocks.useArcOmpProviders,
  useArcLogin: mocks.useArcLogin,
}));

import { AccountsPage } from "./accounts";

function account(overrides: Partial<ArcAccount> = {}): ArcAccount {
  return {
    id: "pool:acct-1",
    sourceId: "acct-1",
    sourceKind: "pool",
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountKey: null,
    email: "j***@example.com",
    planLabel: "Plus",
    authState: "connected",
    enabled: true,
    availableThrough: ["codex"],
    observedAt: 1,
    ...overrides,
  };
}

function provider(overrides: Partial<ArcOmpProvider> = {}): ArcOmpProvider {
  return {
    id: "kimi-code",
    displayName: "Kimi",
    authMethod: "oauth",
    connectionState: "connected",
    hasAccounts: true,
    ...overrides,
  };
}

const noopLogin = () => ({
  openaiStart: vi.fn(),
  openaiPoll: vi.fn(),
  openaiCancel: vi.fn(),
  claudeStart: vi.fn(),
  claudeComplete: vi.fn(),
  ompStart: vi.fn(),
  ompPoll: vi.fn(),
  ompCancel: vi.fn(),
  ompSubmitKey: vi.fn(),
});

function renderAccounts(accounts: ArcAccount[] = [], providers: ArcOmpProvider[] = [], remove = vi.fn()) {
  mocks.useArcAccounts.mockReturnValue({
    accounts,
    sources: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    setEnabled: vi.fn().mockResolvedValue(accounts[0]),
    remove,
    reorder: vi.fn(),
  });
  mocks.useArcOmpProviders.mockReturnValue({ providers, isLoading: false, error: null, refresh: vi.fn() });
  mocks.useArcLogin.mockReturnValue(noopLogin());
  render(<AccountsPage />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AccountsPage", () => {
  it("renders the three account groups", () => {
    renderAccounts([
      account({ id: "pool:openai:1", sourceId: "openai:1", providerFamily: "openai" }),
      account({ id: "pool:anthropic:1", sourceId: "anthropic:1", providerFamily: "anthropic", providerLabel: "Claude", availableThrough: ["claude-code"] }),
    ]);
    expect(screen.getByText("ChatGPT — Used by Codex")).toBeTruthy();
    expect(screen.getByText("Claude — Used by Claude Code")).toBeTruthy();
    expect(screen.getByText("OMP Providers — Used by OMP")).toBeTruthy();
  });

  it("renders multiple accounts with their masked emails", () => {
    renderAccounts([
      account({ id: "pool:openai:1", sourceId: "openai:1", email: "a***@example.com" }),
      account({ id: "pool:openai:2", sourceId: "openai:2", email: "b***@example.com" }),
    ]);
    expect(screen.getByText("a***@example.com")).toBeTruthy();
    expect(screen.getByText("b***@example.com")).toBeTruthy();
  });

  it("renders a disabled account with its auth-state chip", () => {
    renderAccounts([account({ authState: "disabled" })]);
    expect(screen.getByText("Disabled")).toBeTruthy();
  });

  it("gates the remove mutation behind the confirmation dialog", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    renderAccounts([account({ id: "pool:openai:1", sourceId: "openai:1" })], [], remove);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("button", { name: "Remove account" })).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove account" }));
    await screen.findByText("ChatGPT — Used by Codex");
    expect(remove).toHaveBeenCalledWith("pool:openai:1");
  });

  it("does not render a not-connected provider as an account", () => {
    const kimiAccount = account({
      id: "omp:kimi:1",
      sourceId: "kimi:1",
      sourceKind: "omp",
      providerFamily: "kimi-code",
      providerLabel: "Kimi",
      email: "k***@kimi.com",
      availableThrough: ["omp"],
    });
    renderAccounts(
      [kimiAccount],
      [
        provider({ id: "kimi-code", displayName: "Kimi", connectionState: "connected" }),
        provider({ id: "deepseek", displayName: "DeepSeek", connectionState: "not-connected", hasAccounts: false }),
      ],
    );
    expect(screen.getAllByText("Kimi").length).toBeGreaterThan(0);
    expect(screen.getByText("k***@kimi.com")).toBeTruthy();
    expect(screen.queryByText("DeepSeek")).toBeNull();
  });
});
