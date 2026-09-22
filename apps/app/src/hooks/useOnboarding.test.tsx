// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "@bb/domain";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";

const mocks = vi.hoisted(() => ({
  useSystemConfig: vi.fn(),
  useSidebarNavigation: vi.fn(),
  useArcAccountsList: vi.fn(),
  updateGeneralSettingsMutate: vi.fn(),
}));

vi.mock("@/hooks/queries/system-queries", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/queries/system-queries")>(
    "@/hooks/queries/system-queries",
  );
  return { ...actual, useSystemConfig: mocks.useSystemConfig };
});

vi.mock("@/hooks/queries/sidebar-navigation-query", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/queries/sidebar-navigation-query")
  >("@/hooks/queries/sidebar-navigation-query");
  return { ...actual, useSidebarNavigation: mocks.useSidebarNavigation };
});

vi.mock("@/hooks/queries/arc-queries", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/queries/arc-queries")>(
    "@/hooks/queries/arc-queries",
  );
  return { ...actual, useArcAccountsList: mocks.useArcAccountsList };
});

vi.mock("@/hooks/mutations/settings-mutations", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/mutations/settings-mutations")
  >("@/hooks/mutations/settings-mutations");
  return {
    ...actual,
    useUpdateGeneralSettings: () => ({
      mutate: mocks.updateGeneralSettingsMutate,
    }),
  };
});

import { OnboardingProvider, useOnboardingController } from "./useOnboarding";

function emptyBootstrap(): SidebarBootstrapResponse {
  return {
    sections: [],
    projects: [],
    personalProject: {
      id: "personal",
      name: "Personal",
      sources: [],
      threads: [],
      defaultExecutionOptions: null,
    } as unknown as SidebarBootstrapResponse["personalProject"],
  };
}

function bootstrapWithThread(): SidebarBootstrapResponse {
  const base = emptyBootstrap();
  return {
    ...base,
    personalProject: {
      ...base.personalProject,
      threads: [{ id: "thr_1" } as SidebarBootstrapResponse["personalProject"]["threads"][number]],
    },
  };
}

function Probe() {
  const { open, dataReady } = useOnboardingController();
  return (
    <div>
      <span data-testid="open">{String(open)}</span>
      <span data-testid="ready">{String(dataReady)}</span>
    </div>
  );
}

function renderProbe() {
  const { wrapper: Wrapper } = createQueryClientTestHarness();
  return render(
    <Wrapper>
      <OnboardingProvider>
        <Probe />
      </OnboardingProvider>
    </Wrapper>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("onboarding first-run gate", () => {
  it("stays closed while the deciding queries are still loading", () => {
    mocks.useSystemConfig.mockReturnValue({ data: undefined });
    mocks.useSidebarNavigation.mockReturnValue({ data: undefined });
    mocks.useArcAccountsList.mockReturnValue({ data: undefined });

    renderProbe();

    expect(screen.getByTestId("ready").textContent).toBe("false");
    expect(screen.getByTestId("open").textContent).toBe("false");
  });

  it("shows onboarding for a clean profile: no threads, no accounts, not completed", () => {
    mocks.useSystemConfig.mockReturnValue({
      data: { generalSettings: defaultAppSettings },
    });
    mocks.useSidebarNavigation.mockReturnValue({ data: emptyBootstrap() });
    mocks.useArcAccountsList.mockReturnValue({ data: { accounts: [], sources: [] } });

    renderProbe();

    expect(screen.getByTestId("ready").textContent).toBe("true");
    expect(screen.getByTestId("open").textContent).toBe("true");
  });

  it("never auto-shows for an existing user who already has threads", () => {
    mocks.useSystemConfig.mockReturnValue({
      data: { generalSettings: defaultAppSettings },
    });
    mocks.useSidebarNavigation.mockReturnValue({ data: bootstrapWithThread() });
    mocks.useArcAccountsList.mockReturnValue({ data: { accounts: [], sources: [] } });

    renderProbe();

    expect(screen.getByTestId("open").textContent).toBe("false");
  });

  it("never auto-shows for an existing user who already has a connected account", () => {
    mocks.useSystemConfig.mockReturnValue({
      data: { generalSettings: defaultAppSettings },
    });
    mocks.useSidebarNavigation.mockReturnValue({ data: emptyBootstrap() });
    mocks.useArcAccountsList.mockReturnValue({
      data: {
        accounts: [
          {
            id: "a",
            sourceId: "a",
            sourceKind: "pool",
            providerFamily: "openai",
            providerLabel: "ChatGPT",
            accountKey: "a",
            email: null,
            planLabel: null,
            authState: "connected",
            enabled: true,
            availableThrough: ["codex"],
            observedAt: Date.now(),
          },
        ],
        sources: [],
      },
    });

    renderProbe();

    expect(screen.getByTestId("open").textContent).toBe("false");
  });

  it("does not auto-show once onboardingCompleted is already true", () => {
    mocks.useSystemConfig.mockReturnValue({
      data: { generalSettings: { ...defaultAppSettings, onboardingCompleted: true } },
    });
    mocks.useSidebarNavigation.mockReturnValue({ data: emptyBootstrap() });
    mocks.useArcAccountsList.mockReturnValue({ data: { accounts: [], sources: [] } });

    renderProbe();

    expect(screen.getByTestId("open").textContent).toBe("false");
  });
});
