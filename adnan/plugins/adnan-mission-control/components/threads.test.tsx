// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnrichedThread } from "../server";

const mocks = vi.hoisted(() => ({
  useTree: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  useTree: mocks.useTree,
}));

vi.mock("@/lib/bb", () => ({
  useProvidersList: () => [{ id: "codex", displayName: "Codex" }],
}));

vi.mock("@/components/quick-actions", () => ({
  ThreadQuickActions: () => null,
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => ({ toPluginPanel: vi.fn(), toThread: vi.fn(), toUrl: vi.fn() }),
}));

import { ThreadsPage } from "./threads";

function thread(overrides: Partial<EnrichedThread> = {}): EnrichedThread {
  return {
    id: "t1",
    projectId: "p1",
    title: "Fix the bug",
    titleFallback: null,
    parentThreadId: null,
    visibility: "visible",
    status: "active",
    runtimeDisplayStatus: "active",
    providerId: "codex",
    hasPendingInteraction: false,
    pendingCount: 0,
    pendingTitles: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    environment: null,
    model: "gpt-5.6",
    reasoningLevel: null,
    permissionMode: null,
    usage: null,
    context: null,
    lastAction: null,
    childCount: 0,
    provenance: "bb-observed",
    accountKey: null,
    accountLabel: null,
    ...overrides,
  };
}

function renderThreads(threads: EnrichedThread[]) {
  mocks.useTree.mockReturnValue({
    data: {
      threads,
      counters: { total: threads.length, active: threads.length, idle: 0, other: 0, providersInUse: [], pendingInteractions: 0 },
    },
    error: null,
  });
  render(<ThreadsPage />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadsPage account column", () => {
  it("renders the resolved account label when known", () => {
    renderThreads([thread({ accountKey: "acct:openai:abc", accountLabel: "Personal ChatGPT" })]);
    expect(screen.getByText("Personal ChatGPT")).toBeTruthy();
  });

  it("says 'Account unknown' rather than inferring one from other fields", () => {
    renderThreads([thread({ accountKey: null, accountLabel: null })]);
    expect(screen.getByText("Account unknown")).toBeTruthy();
  });
});
