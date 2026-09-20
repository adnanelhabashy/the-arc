// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArcAccount } from "@/hooks/queries/arc-queries";

const mocks = vi.hoisted(() => ({
  useArcAccountsList: vi.fn(),
}));

vi.mock("@/hooks/queries/arc-queries", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/queries/arc-queries")>(
    "@/hooks/queries/arc-queries",
  );
  return { ...actual, useArcAccountsList: mocks.useArcAccountsList };
});

import { AccountPicker } from "./AccountPicker";

function account(overrides: Partial<ArcAccount> = {}): ArcAccount {
  return {
    id: "acct-1",
    sourceId: "src-1",
    sourceKind: "pool",
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountKey: "acct-1",
    email: "adnan@example.com",
    planLabel: "Plus",
    authState: "connected",
    enabled: true,
    availableThrough: ["codex"],
    observedAt: Date.now(),
    ...overrides,
  };
}

function setAccounts(accounts: ArcAccount[]) {
  mocks.useArcAccountsList.mockReturnValue({
    data: { accounts, sources: [] },
    isLoading: false,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AccountPicker", () => {
  it("returns nothing for an unresolved agent", () => {
    setAccounts([account()]);
    const { container } = render(
      <AccountPicker agentId={null} value={null} onChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns nothing for a new thread with no compatible connected accounts", () => {
    setAccounts([]);
    const { container } = render(
      <AccountPicker agentId="codex" value={null} onChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("offers Auto plus only agent-compatible connected accounts for a new thread", () => {
    setAccounts([
      account({ id: "codex-1", accountKey: "codex-1", providerLabel: "Personal ChatGPT" }),
      account({ id: "claude-1", accountKey: "claude-1", availableThrough: ["claude-code"] }),
    ]);
    render(<AccountPicker agentId="codex" value={null} onChange={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Account" }), { button: 0 });
    expect(screen.getByRole("menuitem", { name: /Auto/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Personal ChatGPT/ })).toBeTruthy();
    // The Claude-only account must not appear for the Codex agent.
    const menuItems = screen.getAllByRole("menuitem");
    expect(menuItems).toHaveLength(2);
  });

  it("renders a disconnected account as visibly disabled with a reason, not omitted", () => {
    setAccounts([account({ authState: "expired" })]);
    render(<AccountPicker agentId="codex" value={null} onChange={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Account" }), { button: 0 });
    const item = screen.getByRole("menuitem", { name: /ChatGPT/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Sign-in expired")).toBeTruthy();
  });

  it("calls onChange immediately for a new thread's account selection", () => {
    const onChange = vi.fn();
    setAccounts([account()]);
    render(<AccountPicker agentId="codex" value={null} onChange={onChange} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Account" }), { button: 0 });
    fireEvent.click(screen.getByRole("menuitem", { name: /ChatGPT/ }));
    expect(onChange).toHaveBeenCalledWith("acct-1");
  });

  it("never renders the internal __auto__ sentinel value anywhere", () => {
    setAccounts([account()]);
    const { container } = render(
      <AccountPicker agentId="codex" value={null} onChange={vi.fn()} />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Account" }), { button: 0 });
    expect(container.textContent ?? "").not.toContain("__auto__");
  });

  it("shows a compact 'Select account' trigger and explains legacy state inside the popover, not as a banner", () => {
    setAccounts([account()]);
    render(
      <AccountPicker
        agentId="codex"
        value={null}
        onChange={vi.fn()}
        existingThreadState={{ accountKey: null, accountResolved: false, hasHistory: true }}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Account" });
    expect(trigger.textContent).toContain("Select account");
    expect(screen.queryByText(/before account selection was available/)).toBeNull();

    fireEvent.pointerDown(trigger, { button: 0 });
    expect(
      screen.getByText(/before account selection was available/),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Auto/ })).toBeNull();
  });

  it("flags a stored account that is no longer available and blocks silent resolution", () => {
    setAccounts([account({ accountKey: "acct-1", authState: "disabled" })]);
    render(
      <AccountPicker
        agentId="codex"
        value={null}
        onChange={vi.fn()}
        existingThreadState={{ accountKey: "acct-1", accountResolved: true, hasHistory: true }}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Account" });
    expect(trigger.textContent).toContain("Account unavailable");
    fireEvent.pointerDown(trigger, { button: 0 });
    expect(screen.getByText(/no longer available/)).toBeTruthy();
  });

  it("requires an explicit confirm before switching a resolved thread's account", () => {
    const onChange = vi.fn();
    setAccounts([
      account({ id: "a", accountKey: "a", providerLabel: "Account A" }),
      account({ id: "b", accountKey: "b", providerLabel: "Account B" }),
    ]);
    render(
      <AccountPicker
        agentId="codex"
        value="a"
        onChange={onChange}
        existingThreadState={{ accountKey: "a", accountResolved: true, hasHistory: true }}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Account" });
    expect(trigger.textContent).toContain("Account A · Plus");
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Account B/ }));
    // Selecting does not apply yet — it stages a confirmation, in place.
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText((_, node) => node?.textContent === "Switch account to Account B · Plus?"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("never renders a secret-shaped field from an account row", () => {
    setAccounts([account()]);
    const { container } = render(
      <AccountPicker agentId="codex" value={null} onChange={vi.fn()} />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Account" }), { button: 0 });
    const text = container.textContent ?? "";
    expect(text.toLowerCase()).not.toMatch(/token|secret|refreshtoken|apikey/);
  });

  it("places Manage accounts inside the account dropdown, as its footer", () => {
    setAccounts([account()]);
    const onManage = vi.fn();
    render(
      <AccountPicker agentId="codex" value={null} onChange={vi.fn()} onManageAccounts={onManage} />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Account" }), { button: 0 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage accounts…" }));
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});
