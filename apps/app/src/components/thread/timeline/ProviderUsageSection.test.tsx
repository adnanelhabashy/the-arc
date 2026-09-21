// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import {
  useArcCurrentAgentUsage,
  useArcUsageRefresh,
} from "@/hooks/queries/arc-queries";
import type {
  ArcCurrentAgentUsage,
  ArcUsageResource,
  ArcUsageWindow,
} from "@/hooks/queries/arc-queries";
import { ProviderUsageSection } from "./ProviderUsageSection";

vi.mock("@/hooks/queries/arc-queries", () => ({
  useArcCurrentAgentUsage: vi.fn(),
  useArcUsageRefresh: vi.fn(),
}));

const mockUseArcCurrentAgentUsage = vi.mocked(useArcCurrentAgentUsage);
const mockUseArcUsageRefresh = vi.mocked(useArcUsageRefresh);

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const TWO_HOURS_EIGHTEEN_MINUTES = (2 * 60 + 18) * 60_000;

function makeWindow(
  overrides: Partial<ArcUsageWindow> = {},
): ArcUsageWindow {
  return {
    id: "w1",
    label: "5-hour",
    kind: "five-hour",
    status: "ok",
    usedPercent: 37,
    remainingPercent: 63,
    usedAmount: null,
    limitAmount: null,
    remainingAmount: null,
    unit: null,
    resetsAt: NOW + TWO_HOURS_EIGHTEEN_MINUTES,
    observedAt: null,
    source: "pool",
    ...overrides,
  };
}

function makeResource(
  overrides: Partial<ArcUsageResource> = {},
): ArcUsageResource {
  return {
    id: "r1",
    sourceKind: "pool",
    accountKey: null,
    accountSourceId: null,
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountEmail: "adnan@example.com",
    planLabel: "Pro",
    modelLabel: null,
    agentIds: ["codex"],
    windows: [makeWindow()],
    observedAt: null,
    fetchedAt: NOW - 24_000,
    stale: false,
    status: "available",
    unavailableReason: null,
    credentialDisabled: false,
    message: null,
    sources: ["pool"],
    ...overrides,
  };
}

function makeUsage(
  overrides: Partial<ArcCurrentAgentUsage> = {},
): ArcCurrentAgentUsage {
  return {
    agentId: "codex",
    thread: null,
    resources: [makeResource()],
    activeAccount: null,
    activeAccountUnknown: false,
    ...overrides,
  };
}

function setCurrentAgentUsage(
  data: ArcCurrentAgentUsage | undefined,
  error: unknown = null,
): void {
  mockUseArcCurrentAgentUsage.mockReturnValue({
    data,
    error,
    isError: error !== null,
    isFetching: false,
  } as unknown as UseQueryResult<ArcCurrentAgentUsage, Error>);
}

let refreshMutate: Mock;

function renderSection(providerId: string, modelLabel?: string, modelId?: string) {
  refreshMutate = vi.fn();
  mockUseArcUsageRefresh.mockReturnValue({
    mutate: refreshMutate,
    isPending: false,
  } as unknown as UseMutationResult<
    void,
    Error,
    readonly string[],
    unknown
  >);
  return render(
    <ProviderUsageSection
      active
      providerId={providerId}
      modelLabel={modelLabel}
      modelId={modelId}
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("maps codex and renders percent windows with a reset line", () => {
  setCurrentAgentUsage(makeUsage());
  renderSection("codex", "Claude Sonnet");

  expect(mockUseArcCurrentAgentUsage).toHaveBeenCalledWith({
    agentId: "codex",
    modelId: undefined,
    enabled: true,
  });
  expect(screen.getByText("ChatGPT")).toBeTruthy();
  expect(screen.getByText("Pro · adnan@example.com")).toBeTruthy();
  expect(screen.getByText("5-hour")).toBeTruthy();
  expect(screen.getByText("37% used")).toBeTruthy();
  expect(screen.getByText("63% left")).toBeTruthy();
  expect(screen.getByText("resets in 2h 18m")).toBeTruthy();
  expect(screen.getByText("Model: Claude Sonnet")).toBeTruthy();
  expect(screen.getByText("Updated 24s ago")).toBeTruthy();
});

it("renders amount-only windows as a remaining amount with no percent", () => {
  setCurrentAgentUsage(
    makeUsage({
      resources: [
        makeResource({
          windows: [
            makeWindow({
              label: "Monthly spend",
              usedPercent: null,
              remainingPercent: null,
              remainingAmount: 7.32,
              unit: "usd",
              resetsAt: null,
            }),
          ],
        }),
      ],
    }),
  );
  renderSection("codex");

  expect(screen.getByText("Monthly spend")).toBeTruthy();
  expect(screen.getByText("$7.32 remaining")).toBeTruthy();
  expect(screen.queryByText(/% used/)).toBeNull();
});

it("shows not-exposed as a status line and never a fabricated zero", () => {
  setCurrentAgentUsage(
    makeUsage({
      resources: [
        makeResource({
          status: "unavailable",
          unavailableReason: "not-exposed",
          windows: [],
        }),
      ],
    }),
  );
  renderSection("codex");

  expect(screen.getByText(/not exposed by provider/i)).toBeTruthy();
  expect(screen.queryByText(/0%/)).toBeNull();
});

it("keeps last-good values and notes a failed refresh when stale", () => {
  setCurrentAgentUsage(
    makeUsage({
      resources: [
        makeResource({
          stale: true,
          fetchedAt: NOW - 60_000,
          windows: [makeWindow({ usedPercent: 40, remainingPercent: 60 })],
        }),
      ],
    }),
  );
  renderSection("codex");

  expect(screen.getByText("40% used")).toBeTruthy();
  expect(screen.getByText(/could not refresh/)).toBeTruthy();
});

it("renders a retry line without fabricated zeros when usage errors without data", () => {
  setCurrentAgentUsage(
    makeUsage({
      resources: [makeResource({ status: "error", windows: [] })],
    }),
  );
  renderSection("codex");

  expect(screen.getByText("Usage temporarily unavailable")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByText(/0%/)).toBeNull();
});

it("reports 'Active account unknown' instead of listing every connected account", () => {
  setCurrentAgentUsage(
    makeUsage({
      activeAccountUnknown: true,
      resources: [makeResource({ id: "r1" }), makeResource({ id: "r2" })],
    }),
  );
  renderSection("codex");

  expect(screen.getByText("Active account unknown")).toBeTruthy();
  expect(screen.queryByText("ChatGPT")).toBeNull();
});

it("scopes usage to the thread's bound account when accountKey is known", () => {
  setCurrentAgentUsage(
    makeUsage({
      activeAccountUnknown: false,
      resources: [makeResource({ id: "r1", accountKey: "acct-1" })],
    }),
  );
  refreshMutate = vi.fn();
  mockUseArcUsageRefresh.mockReturnValue({
    mutate: refreshMutate,
    isPending: false,
  } as unknown as UseMutationResult<
    void,
    Error,
    readonly string[],
    unknown
  >);
  render(
    <ProviderUsageSection active providerId="codex" accountKey="acct-1" />,
  );

  expect(mockUseArcCurrentAgentUsage).toHaveBeenCalledWith({
    agentId: "codex",
    accountKey: "acct-1",
    modelId: undefined,
    enabled: true,
  });
  expect(screen.getByText("ChatGPT")).toBeTruthy();
  expect(screen.queryByText("Active account unknown")).toBeNull();
});

it("maps acp-omp to the omp agent", () => {
  setCurrentAgentUsage(makeUsage());
  renderSection("acp-omp");

  expect(mockUseArcCurrentAgentUsage).toHaveBeenCalledWith({
    agentId: "omp",
    modelId: undefined,
    enabled: true,
  });
});

it("renders nothing for an unknown provider", () => {
  setCurrentAgentUsage(makeUsage());
  const { container } = renderSection("pi");

  expect(container.firstChild).toBeNull();
});

it("renders nothing when arc is unavailable", () => {
  setCurrentAgentUsage(
    undefined,
    new Error("arc-unavailable: not an Arc server"),
  );
  const { container } = renderSection("codex");

  expect(container.firstChild).toBeNull();
});

it("refreshes only the resources this panel is showing", () => {
  const usage = makeUsage();
  setCurrentAgentUsage(usage);
  renderSection("codex");

  fireEvent.click(
    screen.getByRole("button", { name: "Refresh provider usage" }),
  );

  expect(refreshMutate).toHaveBeenCalledTimes(1);
  expect(refreshMutate).toHaveBeenCalledWith(
    usage.resources.map((resource) => resource.id),
  );
});

function ompAccountUsage(
  overrides: Partial<ArcCurrentAgentUsage> = {},
): ArcCurrentAgentUsage {
  return makeUsage({
    agentId: "omp",
    activeAccount: {
      accountKey: "omp:kimi-code:credential-1",
      accountSourceId: "omp:kimi-code:1",
      providerLabel: "Kimi Code",
      providerFamily: "kimi-code",
      planLabel: null,
      accountEmail: null,
      resolvedBy: "provider",
    },
    resources: [
      makeResource({
        id: "omp:kimi-code:omp:kimi-code:1",
        sourceKind: "omp",
        accountKey: "omp:kimi-code:credential-1",
        accountSourceId: "omp:kimi-code:1",
        providerFamily: "kimi-code",
        providerLabel: "Kimi Code",
        accountEmail: null,
        planLabel: null,
        agentIds: ["omp"],
        sources: ["omp"],
        windows: [
          makeWindow({
            id: "kimi-code:0",
            label: "Weekly limit",
            kind: "weekly",
            status: "exhausted",
            usedPercent: null,
            remainingPercent: null,
            usedAmount: 100,
            limitAmount: 100,
            remainingAmount: 0,
            unit: "unknown",
          }),
          makeWindow({
            id: "kimi-code:1",
            label: "5h limit",
            kind: "five-hour",
            status: "ok",
            usedPercent: null,
            remainingPercent: null,
            usedAmount: 0,
            limitAmount: 100,
            remainingAmount: 100,
            unit: "unknown",
          }),
        ],
      }),
    ],
    ...overrides,
  });
}

it("names the account an unpinned OMP thread runs on and shows its real limits", () => {
  setCurrentAgentUsage(ompAccountUsage());
  renderSection("acp-omp", "Kimi For Coding", "kimi-code/kimi-for-coding");

  expect(mockUseArcCurrentAgentUsage).toHaveBeenCalledWith({
    agentId: "omp",
    modelId: "kimi-code/kimi-for-coding",
    enabled: true,
  });
  expect(
    screen.getByText(
      (_content, element) => element?.textContent === "Active account Kimi Code",
    ),
  ).toBeTruthy();
  expect(screen.queryByText("Active account unknown")).toBeNull();
  expect(screen.getByText("Weekly limit")).toBeTruthy();
  expect(screen.getByText("0 remaining")).toBeTruthy();
  expect(screen.getByText("5h limit")).toBeTruthy();
  expect(screen.getByText("100 remaining")).toBeTruthy();
});

it("keeps the OMP provider's percent windows when the account reports them", () => {
  setCurrentAgentUsage(
    ompAccountUsage({
      activeAccount: {
        accountKey: null,
        accountSourceId: "omp:opencode-go:1",
        providerLabel: "OpenCode Go",
        providerFamily: "opencode-go",
        planLabel: null,
        accountEmail: null,
        resolvedBy: "provider",
      },
      resources: [
        makeResource({
          id: "omp:opencode-go:omp:opencode-go:1",
          sourceKind: "omp",
          accountKey: null,
          accountSourceId: "omp:opencode-go:1",
          providerFamily: "opencode-go",
          providerLabel: "OpenCode Go",
          accountEmail: null,
          planLabel: null,
          agentIds: ["omp"],
          sources: ["omp"],
          windows: [
            makeWindow({
              id: "rolling-5h",
              label: "5 Hour limit",
              usedPercent: 11,
              remainingPercent: 89,
            }),
          ],
        }),
      ],
    }),
  );
  renderSection("acp-omp", "Ox Alpha Free", "opencode-go/ox-alpha-free");

  expect(mockUseArcCurrentAgentUsage).toHaveBeenCalledWith({
    agentId: "omp",
    modelId: "opencode-go/ox-alpha-free",
    enabled: true,
  });
  expect(
    screen.getByText(
      (_content, element) => element?.textContent === "Active account OpenCode Go",
    ),
  ).toBeTruthy();
  expect(screen.getByText("11% used")).toBeTruthy();
  expect(screen.getByText("89% left")).toBeTruthy();
});

it("still reports unknown for an OMP thread Arc cannot attribute", () => {
  setCurrentAgentUsage(
    ompAccountUsage({
      activeAccount: null,
      activeAccountUnknown: true,
      resources: [
        makeResource({ id: "omp:kimi-code:1", sourceKind: "omp" }),
        makeResource({ id: "omp:kimi-code:2", sourceKind: "omp" }),
      ],
    }),
  );
  renderSection("acp-omp", "Kimi For Coding", "kimi-code/kimi-for-coding");

  expect(screen.getByText("Active account unknown")).toBeTruthy();
  expect(screen.queryByText("Kimi Code")).toBeNull();
});

it("does not label a thread-bound account as provider-resolved", () => {
  setCurrentAgentUsage(
    makeUsage({
      activeAccount: {
        accountKey: "openai:chatgpt:acc-1",
        accountSourceId: "a1",
        providerLabel: "ChatGPT",
        providerFamily: "openai",
        planLabel: "Pro",
        accountEmail: "adnan@example.com",
        resolvedBy: "binding",
      },
    }),
  );
  renderSection("codex");

  expect(screen.queryByText("Active account")).toBeNull();
  expect(screen.getByText("Pro · adnan@example.com")).toBeTruthy();
});

it("links to the full usage page's real route, not the plugin root", () => {
  setCurrentAgentUsage(makeUsage());
  renderSection("codex");

  expect(
    screen.getByRole("link", { name: "View all usage" }).getAttribute("href"),
  ).toBe("/plugins/adnan-mission-control/mission-control/usage");
});
