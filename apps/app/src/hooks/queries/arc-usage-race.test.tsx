// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useArcCurrentAgentUsage } from "./arc-queries";

// The account-switch race, tested against the real cache rather than a mock:
// a refresh started for the OMP provider a thread was using must never land in
// the state shown after the thread moved to another provider. The model id is
// part of the query key for exactly this reason.

function envelope(modelId: string, providerLabel: string, accountKey: string | null) {
  return {
    ok: true,
    result: {
      agentId: "omp",
      thread: null,
      resources: [],
      activeAccount: {
        accountKey,
        accountSourceId: accountKey === null ? "omp:opencode-go:1" : "omp:kimi-code:1",
        providerLabel,
        providerFamily: modelId.split("/")[0]!,
        planLabel: null,
        accountEmail: null,
        resolvedBy: "provider",
      },
      activeAccountUnknown: false,
    },
  };
}

interface PendingRequest {
  modelId: string;
  resolve: (body: unknown) => void;
}

let pending: PendingRequest[] = [];

function stubFetch(): void {
  pending = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        activeModelId?: string;
      };
      const modelId = body.activeModelId ?? "";
      const response = await new Promise<unknown>((resolve) => {
        pending.push({ modelId, resolve });
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify(response),
      } as unknown as Response;
    }),
  );
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  stubFetch();
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

function resolve(modelId: string, body: unknown): void {
  const request = pending.find((entry) => entry.modelId === modelId);
  if (request === undefined) throw new Error(`no pending request for ${modelId}`);
  request.resolve(body);
}

it("keeps the new provider's state when the previous provider answers late", async () => {
  const { result, rerender } = renderHook(
    ({ modelId }: { modelId: string }) =>
      useArcCurrentAgentUsage({ agentId: "omp", modelId, enabled: true }),
    { initialProps: { modelId: "kimi-code/kimi-for-coding" }, wrapper },
  );

  await waitFor(() => expect(pending).toHaveLength(1));
  expect(pending[0]!.modelId).toBe("kimi-code/kimi-for-coding");

  // The thread moves to another OMP provider while Kimi is still in flight.
  rerender({ modelId: "opencode-go/ox-alpha-free" });
  await waitFor(() =>
    expect(pending.map((entry) => entry.modelId)).toContain(
      "opencode-go/ox-alpha-free",
    ),
  );

  resolve(
    "opencode-go/ox-alpha-free",
    envelope("opencode-go/ox-alpha-free", "OpenCode Go", null),
  );
  await waitFor(() =>
    expect(result.current.data?.activeAccount?.providerLabel).toBe(
      "OpenCode Go",
    ),
  );

  // The stale Kimi answer arrives last and must not overwrite what is shown.
  resolve(
    "kimi-code/kimi-for-coding",
    envelope("kimi-code/kimi-for-coding", "Kimi Code", "omp:kimi-code:credential-1"),
  );
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  expect(result.current.data?.activeAccount?.providerLabel).toBe("OpenCode Go");

  // Going back to Kimi shows Kimi's own cached answer, not OpenCode's.
  rerender({ modelId: "kimi-code/kimi-for-coding" });
  await waitFor(() =>
    expect(result.current.data?.activeAccount?.providerLabel).toBe("Kimi Code"),
  );
});

it("re-reads when the thread's model changes within the same provider", async () => {
  const { result, rerender } = renderHook(
    ({ modelId }: { modelId: string }) =>
      useArcCurrentAgentUsage({ agentId: "omp", modelId, enabled: true }),
    { initialProps: { modelId: "opencode-go/ox-alpha-free" }, wrapper },
  );

  await waitFor(() => expect(pending).toHaveLength(1));
  resolve(
    "opencode-go/ox-alpha-free",
    envelope("opencode-go/ox-alpha-free", "OpenCode Go", null),
  );
  await waitFor(() =>
    expect(result.current.data?.activeAccount?.providerLabel).toBe(
      "OpenCode Go",
    ),
  );

  rerender({ modelId: "opencode-go/deepseek-v4-pro" });
  await waitFor(() => expect(pending).toHaveLength(2));
  expect(pending[1]!.modelId).toBe("opencode-go/deepseek-v4-pro");
  resolve(
    "opencode-go/deepseek-v4-pro",
    envelope("opencode-go/deepseek-v4-pro", "OpenCode Go", null),
  );
  await waitFor(() =>
    expect(result.current.data?.activeAccount?.providerLabel).toBe(
      "OpenCode Go",
    ),
  );});
