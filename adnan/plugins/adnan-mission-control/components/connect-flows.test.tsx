// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArcOmpProvider } from "@/lib/arc-types";

const mocks = vi.hoisted(() => ({
  useArcLogin: vi.fn(),
  useArcOmpProviders: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  useArcLogin: mocks.useArcLogin,
  useArcOmpProviders: mocks.useArcOmpProviders,
}));

import { ChatGptConnectDialog, OmpProviderPickerDialog } from "./connect-flows";

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
  render(<OmpProviderPickerDialog open onOpenChange={() => {}} onConnected={onConnected} />);
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
