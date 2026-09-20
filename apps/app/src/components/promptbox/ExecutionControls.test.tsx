// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import type { ArcAccount, ArcAccountsList } from "@/hooks/queries/arc-queries";
import {
  ExecutionControls,
  type ExecutionControlsProps,
} from "./ExecutionControls";

function makeExecutionControlsProps(
  providerOnChange?: (value: string) => void,
): ExecutionControlsProps {
  return {
    provider: {
      options: [
        { value: "codex", label: "Codex" },
        { value: "claude", label: "Claude Code" },
      ],
      selectedId: "codex",
      onChange: providerOnChange,
      hasMultiple: true,
    },
    model: {
      active: null,
      selected: "gpt-5",
      options: [{ value: "gpt-5", label: "GPT-5" }],
      moreOptions: [],
      isLoading: false,
      loadFailed: false,
      loadError: null,
      onChange: vi.fn(),
    },
    reasoning: {
      value: "medium",
      options: [{ value: "medium", label: "Medium" }],
      onChange: vi.fn(),
    },
  };
}

function renderExecutionControls(
  props: ExecutionControlsProps,
  seedArcAccounts?: readonly ArcAccount[],
) {
  const { wrapper, queryClient } = createQueryClientTestHarness();
  if (seedArcAccounts !== undefined) {
    queryClient.setQueryData<ArcAccountsList>(["arcAccounts"], {
      accounts: [...seedArcAccounts],
      sources: [],
    });
  }
  return render(<ExecutionControls {...props} />, { wrapper });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ExecutionControls", () => {
  it("hides provider tabs when the provider is locked", () => {
    renderExecutionControls(makeExecutionControlsProps());

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );

    expect(screen.queryByText("Model")).not.toBeNull();
    expect(screen.queryByTitle("Claude Code")).toBeNull();
  });

  it("shows provider tabs when provider changes are allowed", () => {
    renderExecutionControls(makeExecutionControlsProps(vi.fn()));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );

    expect(screen.queryByTitle("Claude Code")).not.toBeNull();
  });

  it("keeps showing the known model when model options fail to load", () => {
    const props = makeExecutionControlsProps();
    renderExecutionControls({
      ...props,
      model: {
        ...props.model,
        active: { model: "o4-mini" },
        options: [],
        loadFailed: true,
        loadError: { providerId: "codex", code: "failed" },
      },
    });

    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });

    expect(trigger.textContent).toContain("o4-mini");
    expect(trigger.textContent).not.toContain("Failed to load models");
  });

  it("maps disabled fast mode to the explicit default service tier", () => {
    const onServiceTierChange = vi.fn();
    renderExecutionControls({
      ...makeExecutionControlsProps(),
      serviceTier: {
        value: "fast",
        onChange: onServiceTierChange,
        supported: true,
      },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Fast mode" }));

    expect(onServiceTierChange).toHaveBeenCalledWith("default");
  });

  it("renders no account picker when no agent is resolved", () => {
    const { container } = renderExecutionControls({
      ...makeExecutionControlsProps(),
      account: {
        agentId: null,
        value: null,
        onChange: vi.fn(),
      },
    });

    expect(container.querySelector('[aria-label="Account"]')).toBeNull();
  });

  it("renders the account picker trigger when an agent is resolved", () => {
    renderExecutionControls(
      {
        ...makeExecutionControlsProps(),
        account: {
          agentId: "codex",
          value: null,
          onChange: vi.fn(),
        },
      },
      [
        {
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
        },
      ],
    );

    expect(screen.getByRole("button", { name: "Account" })).toBeTruthy();
  });
});
