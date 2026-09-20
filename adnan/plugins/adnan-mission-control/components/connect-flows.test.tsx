// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArcOmpProvider, ArcOpenAiLoginChallenge } from "@/lib/arc-types";

const mocks = vi.hoisted(() => ({
  useArcLogin: vi.fn(),
  useArcOmpProviders: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  useArcLogin: mocks.useArcLogin,
  useArcOmpProviders: mocks.useArcOmpProviders,
}));

import { ChatGptConnectDialog, ClaudeConnectDialog, OmpProviderPickerDialog } from "./connect-flows";

function provider(overrides: Partial<ArcOmpProvider> = {}): ArcOmpProvider {
  return {
    id: "kimi-code",
    displayName: "Kimi",
    authMethod: "oauth",
    connectionState: "not-connected",
    hasAccounts: false,
    ...overrides,
  };
}

const baseLogin = () => ({
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

function renderPicker(providers: ArcOmpProvider[], onConnected = vi.fn()) {
  mocks.useArcOmpProviders.mockReturnValue({ providers, isLoading: false, error: null, refresh: vi.fn() });
  return render(<OmpProviderPickerDialog open onOpenChange={() => {}} onConnected={onConnected} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatGptConnectDialog", () => {
  it("renders the device code", async () => {
    mocks.useArcLogin.mockReturnValue({
      ...baseLogin(),
      openaiStart: vi.fn().mockResolvedValue({
        provider: "openai",
        sessionId: "s1",
        verificationUri: "https://auth.openai.com/device",
        userCode: "ABCD-EFGH",
        expiresAt: Date.now() + 60_000,
        intervalMs: 10_000,
      }),
    });
    render(<ChatGptConnectDialog open onOpenChange={() => {}} onConnected={() => {}} />);
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Sign-In Page" })).toBeTruthy();
  });

  it("renders the expired state after a poll reports expiry", async () => {
    mocks.useArcLogin.mockReturnValue({
      ...baseLogin(),
      openaiStart: vi.fn().mockResolvedValue({
        provider: "openai",
        sessionId: "s1",
        verificationUri: "https://auth.openai.com/device",
        userCode: "ABCD-EFGH",
        expiresAt: Date.now() + 60_000,
        intervalMs: 1,
      }),
      openaiPoll: vi.fn().mockResolvedValue({ poll: { state: "waiting-for-user", account: null, message: null }, state: "expired" }),
    });
    render(<ChatGptConnectDialog open onOpenChange={() => {}} onConnected={() => {}} />);
    expect(await screen.findByText("Code expired")).toBeTruthy();
  });
});

describe("OmpProviderPickerDialog", () => {
  it("filters a large provider list and caps rendering at 50", () => {
    const providers = Array.from({ length: 75 }, (_, index) =>
      provider({ id: `prov-${index}`, displayName: `Provider ${index}` }),
    );
    renderPicker(providers);

    expect(screen.getByText("25 more — keep typing")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Search providers…"), { target: { value: "Provider 42" } });
    expect(screen.getByText("Provider 42")).toBeTruthy();
    expect(screen.queryByText("Provider 43")).toBeNull();
    expect(screen.queryByText(/more — keep typing/)).toBeNull();
  });

  it("submits the API key and clears the input", async () => {
    const ompSubmitKey = vi.fn().mockResolvedValue(undefined);
    mocks.useArcLogin.mockReturnValue({
      ...baseLogin(),
      ompStart: vi.fn().mockResolvedValue({
        provider: "kimi-code",
        sessionId: "s1",
        kind: "api-key",
        authorizeUrl: null,
        instructions: null,
        expiresAt: null,
      }),
      ompSubmitKey,
    });
    renderPicker([provider({ authMethod: "api-key" })]);

    fireEvent.click(screen.getByRole("button", { name: /Kimi/ }));
    const input = (await screen.findByPlaceholderText("Paste your API key")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-secret-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(ompSubmitKey).toHaveBeenCalledWith("s1", "sk-secret-key"));
    expect((screen.getByPlaceholderText("Paste your API key") as HTMLInputElement).value).toBe("");
  });

  it("transitions the oauth flow from waiting to connected", async () => {
    const onConnected = vi.fn();
    mocks.useArcLogin.mockReturnValue({
      ...baseLogin(),
      ompStart: vi.fn().mockResolvedValue({
        provider: "kimi-code",
        sessionId: "s1",
        kind: "oauth",
        authorizeUrl: "https://auth.example.com/authorize",
        instructions: null,
        expiresAt: null,
      }),
      ompPoll: vi.fn().mockResolvedValue({ state: "connected", account: null, message: null }),
    });
    renderPicker([provider({ authMethod: "oauth" })], onConnected);

    fireEvent.click(screen.getByRole("button", { name: /Kimi/ }));
    expect(await screen.findByRole("button", { name: "Open Authorization Page" })).toBeTruthy();

    await waitFor(() => expect(onConnected).toHaveBeenCalled(), { timeout: 5_000 });
  });
});

describe("Phase 10.1 login stability", () => {
  const openaiChallenge: ArcOpenAiLoginChallenge = {
    provider: "openai",
    sessionId: "s1",
    verificationUri: "https://auth.openai.com/device",
    userCode: "ABCD-EFGH",
    expiresAt: Date.now() + 60_000,
    intervalMs: 1,
  };

  it("starts ChatGPT login exactly once even when hook identities churn on every render", async () => {
    const openaiStart = vi.fn().mockResolvedValue(openaiChallenge);
    const openaiPoll = vi.fn().mockResolvedValue({ poll: { state: "waiting-for-user", account: null, message: null }, state: "waiting-for-user" });
    // Simulate the pre-fix world: every render receives brand-new closures.
    mocks.useArcLogin.mockImplementation(() => ({ ...baseLogin(), openaiStart, openaiPoll }));
    const { rerender } = render(<ChatGptConnectDialog open onOpenChange={() => {}} onConnected={() => {}} />);

    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    rerender(<ChatGptConnectDialog open onOpenChange={() => {}} onConnected={() => {}} />);
    rerender(<ChatGptConnectDialog open onOpenChange={() => {}} onConnected={() => {}} />);
    rerender(<ChatGptConnectDialog open onOpenChange={() => {}} onConnected={() => {}} />);

    expect(openaiStart).toHaveBeenCalledTimes(1);
    // The dialog stayed in the waiting state across refreshes (no
    // starting → reset loop).
    expect(screen.getByText("Waiting for authorization…")).toBeTruthy();
    expect(screen.queryByText("Starting…")).toBeNull();
  });

  it("completes ChatGPT login without flicker when a poll refresh arrives", async () => {
    const onConnected = vi.fn();
    const onOpenChange = vi.fn();
    const openaiStart = vi.fn().mockResolvedValue(openaiChallenge);
    const openaiPoll = vi.fn().mockResolvedValue({ poll: { state: "connected", account: null, message: null }, state: "connected" });
    mocks.useArcLogin.mockReturnValue({ ...baseLogin(), openaiStart, openaiPoll });
    render(<ChatGptConnectDialog open onOpenChange={onOpenChange} onConnected={onConnected} />);

    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(openaiStart).toHaveBeenCalledTimes(1);
  });

  it("shows a ChatGPT failure state with Try Again when the start fails", async () => {
    const openaiStart = vi.fn().mockRejectedValue(new Error("pool unreachable"));
    mocks.useArcLogin.mockReturnValue({ ...baseLogin(), openaiStart });
    render(<ChatGptConnectDialog open onOpenChange={() => {}} onConnected={() => {}} />);

    expect(await screen.findByText("Authorization failed")).toBeTruthy();
    expect(screen.getByText("pool unreachable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeTruthy();
    expect(openaiStart).toHaveBeenCalledTimes(1);
  });

  it("asks for the Claude authentication code, submits it once, and clears it", async () => {
    const claudeComplete = vi.fn().mockResolvedValue({ id: "pool:1" });
    mocks.useArcLogin.mockReturnValue({
      ...baseLogin(),
      claudeStart: vi.fn().mockResolvedValue({
        provider: "anthropic",
        sessionId: "claude-1",
        authorizeUrl: "https://claude.com/cai/oauth/authorize?code=true",
        expiresAt: null,
      }),
      claudeComplete,
    });
    render(<ClaudeConnectDialog open onOpenChange={() => {}} onConnected={() => {}} />);

    // The callback-URL field is gone; the code field is what the real
    // Claude Code 2.1.x flow needs.
    expect(await screen.findByText("Authentication code")).toBeTruthy();
    expect(screen.queryByPlaceholderText(/callback URL/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Open Anthropic Sign-In" })).toBeTruthy();

    const input = screen.getByPlaceholderText("Paste the code shown on Anthropic's page");
    fireEvent.change(input, { target: { value: "WXYZ-1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete Sign-In" }));

    await waitFor(() => expect(claudeComplete).toHaveBeenCalledTimes(1));
    expect(claudeComplete).toHaveBeenCalledWith("claude-1", "WXYZ-1234");
    // The code is cleared immediately and never persisted anywhere.
    expect((input as HTMLInputElement).value).toBe("");
    expect(window.localStorage.length).toBe(0);
  });

  it("shows the OMP device code and waits, then completes on poll success", async () => {
    const onConnected = vi.fn();
    mocks.useArcLogin.mockReturnValue({
      ...baseLogin(),
      ompStart: vi.fn().mockResolvedValue({
        provider: "kimi-code",
        sessionId: "s1",
        kind: "oauth",
        flow: "device",
        userCode: "W8KT-XSI2",
        authorizeUrl: "https://www.kimi.com/code/authorize_device?user_code=W8KT-XSI2",
        instructions: "Enter code: W8KT-XSI2",
        expiresAt: null,
      }),
      ompPoll: vi.fn().mockResolvedValue({ state: "connected", account: null, message: null }),
    });
    renderPicker([provider({ authMethod: "oauth" })], onConnected);

    fireEvent.click(screen.getByRole("button", { name: /Kimi/ }));
    expect(await screen.findByText("W8KT-XSI2")).toBeTruthy();
    expect(screen.getByText("Waiting for authorization…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Authorization Page" })).toBeTruthy();

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1), { timeout: 5_000 });
  });

  it("shows Authorization expired with Try Again when the OMP login times out", async () => {
    // shouldAdvanceTime keeps testing-library's real-time waits working
    // while the 10-minute expiry timer stays under fake-time control.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.useArcLogin.mockReturnValue({
        ...baseLogin(),
        ompStart: vi.fn().mockResolvedValue({
          provider: "kimi-code",
          sessionId: "s1",
          kind: "oauth",
          flow: "device",
          userCode: "W8KT-XSI2",
          authorizeUrl: "https://www.kimi.com/code/authorize_device?user_code=W8KT-XSI2",
          instructions: null,
          expiresAt: null,
        }),
        ompPoll: vi.fn().mockResolvedValue({ state: "waiting-for-user", account: null, message: null }),
      });
      renderPicker([provider({ authMethod: "oauth" })]);

      fireEvent.click(screen.getByRole("button", { name: /Kimi/ }));
      expect(await screen.findByText("W8KT-XSI2")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(10 * 60 * 1_000);
      });
      expect(screen.getByText("Authorization expired")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Try Again" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the OMP login session mounted across provider-list refreshes", async () => {
    const onConnected = vi.fn();
    const ompStart = vi.fn().mockResolvedValue({
      provider: "kimi-code",
      sessionId: "s1",
      kind: "oauth",
      flow: "browser",
      userCode: null,
      authorizeUrl: "https://auth.example.com/authorize",
      instructions: null,
      expiresAt: null,
    });
    const ompPoll = vi.fn().mockResolvedValue({ state: "waiting-for-user", account: null, message: null });
    mocks.useArcLogin.mockReturnValue({ ...baseLogin(), ompStart, ompPoll });
    const initial = [
      provider(),
      ...Array.from({ length: 74 }, (_, index) =>
        provider({ id: `prov-${index}`, displayName: `Provider ${index}` }),
      ),
    ];
    const view = renderPicker(initial, onConnected);

    fireEvent.click(screen.getByRole("button", { name: /Kimi/ }));
    expect(await screen.findByRole("button", { name: "Open Authorization Page" })).toBeTruthy();

    // A provider/account refresh delivers a new list: the active login
    // dialog must remain untouched (no restart, no remount, no reset).
    mocks.useArcOmpProviders.mockReturnValue({
      providers: [provider({ connectionState: "unknown" })],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });
    view.rerender(<OmpProviderPickerDialog open onOpenChange={() => {}} onConnected={onConnected} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Open Authorization Page" })).toBeTruthy());
    expect(ompStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Starting…")).toBeNull();
    expect(screen.queryByPlaceholderText("Search providers…")).toBeNull();
  });
});
