// The Arc usage render rules decide what a window is allowed to say. These are
// the boundaries that carry the invariants the two surfaces share: a window
// with nothing measurable never becomes a percentage, a provider-reported zero
// is exhaustion, and the same window is named the same way whoever reports it.
import { describe, expect, it } from "vitest";
import type { ArcUsageResource, ArcUsageWindow } from "@/lib/arc-types";
import {
  accountTitle,
  quotaState,
  windowDisplayLabel,
  windowValueLabel,
} from "./usage-window-format";

function window(overrides: Partial<ArcUsageWindow> = {}): ArcUsageWindow {
  return {
    id: "w1",
    label: "Weekly limit",
    kind: "weekly",
    status: null,
    usedPercent: null,
    remainingPercent: null,
    usedAmount: null,
    limitAmount: null,
    remainingAmount: null,
    unit: "unknown",
    resetsAt: null,
    observedAt: null,
    source: null,
    ...overrides,
  };
}

function resource(overrides: Partial<ArcUsageResource> = {}): ArcUsageResource {
  return {
    id: "pool:openai:1",
    sourceKind: "pool",
    accountKey: null,
    accountSourceId: null,
    providerFamily: "openai",
    providerLabel: "ChatGPT",
    accountEmail: null,
    planLabel: null,
    modelLabel: null,
    agentIds: ["codex"],
    windows: [],
    observedAt: null,
    fetchedAt: null,
    stale: false,
    status: "available",
    unavailableReason: null,
    credentialDisabled: false,
    message: null,
    sources: ["pool"],
    ...overrides,
  };
}

describe("quotaState", () => {
  it("trusts the provider's own status over the numbers", () => {
    expect(quotaState(window({ status: "exhausted", usedPercent: 10 }))).toBe("exhausted");
    expect(quotaState(window({ status: "warning", usedPercent: 10 }))).toBe("low");
  });

  it("reads a reported zero remaining as exhaustion with no status to help", () => {
    expect(
      quotaState(window({ usedAmount: 100, limitAmount: 100, remainingAmount: 0 })),
    ).toBe("exhausted");
    expect(quotaState(window({ remainingPercent: 0 }))).toBe("exhausted");
  });

  it("grades the remaining fraction on the same numbers the bar is drawn from", () => {
    expect(quotaState(window({ usedPercent: 27 }))).toBe("ok");
    expect(quotaState(window({ usedPercent: 80 }))).toBe("low");
    expect(quotaState(window({ usedPercent: 100 }))).toBe("exhausted");
  });

  it("stays unknown when the provider measured nothing", () => {
    expect(quotaState(window())).toBe("unknown");
  });
});

describe("windowValueLabel", () => {
  it("keeps the provider's own amount", () => {
    expect(windowValueLabel(window({ remainingAmount: 7.32, unit: "credits" }))).toBe(
      "7.32 credits remaining",
    );
  });

  it("says a window is spent when only its status is known", () => {
    expect(windowValueLabel(window({ status: "exhausted" }))).toBe("Exhausted");
  });

  it("says nothing rather than zero when the provider reported nothing", () => {
    expect(windowValueLabel(window())).toBe("n/a");
  });
});

describe("windowDisplayLabel", () => {
  it("names one window the same way whichever provider reported it", () => {
    expect(windowDisplayLabel(window({ label: "5 Hour limit" }))).toBe("5h");
    expect(windowDisplayLabel(window({ label: "Five-hour limit" }))).toBe("5h");
    expect(windowDisplayLabel(window({ label: "Weekly limit" }))).toBe("Weekly");
    expect(windowDisplayLabel(window({ label: "Monthly limit" }))).toBe("Monthly");
  });

  it("keeps a label it does not recognise verbatim", () => {
    expect(windowDisplayLabel(window({ label: "Rolling credits" }))).toBe("Rolling credits");
  });
});

describe("accountTitle", () => {
  it("combines the provider with its plan", () => {
    expect(accountTitle(resource({ planLabel: "plus" }))).toBe("ChatGPT Plus");
  });

  it("never prints the provider twice", () => {
    expect(accountTitle(resource({ providerLabel: "Kimi Code", planLabel: "Kimi Code" }))).toBe(
      "Kimi Code",
    );
    expect(accountTitle(resource({ providerLabel: "OpenCode Go" }))).toBe("OpenCode Go");
  });
});
