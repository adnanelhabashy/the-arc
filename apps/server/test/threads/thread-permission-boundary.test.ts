import { describe, expect, it } from "vitest";
import { updateHost } from "@bb/db";
import { buildExecutionOptions } from "../../src/services/threads/thread-commands.js";
import { resolveExistingThreadPermissionMode } from "../../src/services/threads/thread-execution-plan.js";
import { seedEnvironment, seedHostSession, seedProjectWithSource, seedThread } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

/**
 * The server is the only place permission resolution happens, so this suite
 * exercises the boundary that every caller — composer, CLI, workflow worker,
 * automation, Mission Control role dispatch, child thread, fork — goes
 * through, rather than each caller's own copy of the rules.
 */
describe("resolveExistingThreadPermissionMode — the one permission boundary", () => {
  async function withThread(
    args: {
      providerId: string;
      ceiling?: "accept-edits" | "auto" | "full";
      parentProviderId?: string;
      recordedMode?: "accept-edits" | "auto" | "full" | "readonly";
    },
    run: (context: {
      permissionMode: () => string;
      deps: Parameters<typeof buildExecutionOptions>[0];
      threadId: string;
    }) => Promise<void> | void,
  ): Promise<void> {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: `host-permission-${args.providerId}-${args.ceiling ?? "full"}`,
      });
      if (args.ceiling !== undefined) {
        updateHost(harness.deps.db, harness.deps.hub, host.id, {
          maxPermissionMode: args.ceiling,
        });
      }
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const parent =
        args.parentProviderId === undefined
          ? null
          : seedThread(harness.deps, {
              projectId: project.id,
              environmentId: environment.id,
              providerId: args.parentProviderId,
            });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: parent?.id ?? null,
        providerId: args.providerId,
      });

      await run({
        deps: harness.deps,
        threadId: thread.id,
        permissionMode: () =>
          resolveExistingThreadPermissionMode(harness.deps, thread.id),
      });
    });
  }

  it("resolves the product default within the provider's modes", async () => {
    await withThread({ providerId: "codex" }, ({ permissionMode }) => {
      expect(permissionMode()).toBe("auto");
    });
  });

  it("adapts the product default down for a provider without auto", async () => {
    await withThread({ providerId: "acp-cursor" }, ({ permissionMode }) => {
      expect(permissionMode()).toBe("accept-edits");
    });
  });

  it("refuses rather than raising the level for a full-only provider, and says what to select", async () => {
    await withThread({ providerId: "pi" }, ({ deps, threadId }) => {
      // The failure has to be actionable: the user's only way forward is to
      // select Full Access themselves, so the message names the mode the way
      // the composer picker does and says Arc will not select it for them.
      expect(() => resolveExistingThreadPermissionMode(deps, threadId)).toThrow(
        "This provider requires Full Access",
      );
      expect(() => resolveExistingThreadPermissionMode(deps, threadId)).toThrow(
        "select Full Access to run it",
      );
      expect(() =>
        resolveExistingThreadPermissionMode(deps, threadId),
      ).toThrow("will not raise the permission level");
    });
  });

  it("adapts an inherited auto down to Accept Edits for OMP, the reported breakage", async () => {
    // OMP is an ACP provider: it declares accept-edits and full, no auto. An
    // auto origin used to reach the provider as `auto` and fail there.
    await withThread(
      { providerId: "acp-omp", parentProviderId: "codex" },
      ({ permissionMode }) => {
        expect(permissionMode()).toBe("accept-edits");
      },
    );
  });

  it("keeps auto for Claude Code, which supports all three modes", async () => {
    await withThread({ providerId: "claude-code" }, ({ permissionMode }) => {
      expect(permissionMode()).toBe("auto");
    });
  });

  it("honours an explicit Full Access for a provider that supports it", async () => {
    await withThread({ providerId: "claude-code" }, async ({ deps, threadId }) => {
      const execution = await buildExecutionOptions(
        deps,
        { model: "claude-sonnet-4-5", permissionMode: "full" },
        { threadId },
      );
      expect(execution.permissionMode).toBe("full");
    });
  });

  it("never resolves above the machine ceiling", async () => {
    await withThread(
      { providerId: "codex", ceiling: "accept-edits" },
      ({ permissionMode }) => {
        expect(permissionMode()).toBe("accept-edits");
      },
    );
  });

  it("reports a ceiling conflict when the provider fits nowhere under it", async () => {
    await withThread(
      { providerId: "pi", ceiling: "auto" },
      ({ deps, threadId }) => {
        expect(() =>
          resolveExistingThreadPermissionMode(deps, threadId),
        ).toThrow("This machine limits permission mode");
      },
    );
  });

  it("inherits a parent's mode for a child on the same provider", async () => {
    await withThread(
      { providerId: "codex", parentProviderId: "codex" },
      ({ permissionMode }) => {
        expect(permissionMode()).toBe("auto");
      },
    );
  });

  it("adapts an inherited parent mode to the child's provider", async () => {
    await withThread(
      { providerId: "acp-cursor", parentProviderId: "codex" },
      ({ permissionMode }) => {
        expect(permissionMode()).toBe("accept-edits");
      },
    );
  });
});
