import { getNonDestroyedHostByLaunchKey } from "@bb/db";
import { sweepProviderMachine } from "../machines/provider-orchestration.js";
import { cancelProviderEnvironmentCreation } from "../environments/environment-engine.js";
import { getPreparingEnvironment } from "@bb/db";
import {
  getThread,
  getThreadAccountState,
  setThreadAccount,
  type DbTransaction,
  type EnvironmentRow,
} from "@bb/db";
import { createAccountPoolHttpRpcClient } from "@bb/arc-domains";
import {
  type EnvironmentProviderSelection,
  type PromptInput,
  type ResolvedThreadExecutionOptions,
  type SystemMessageKind,
  type SystemMessageSubject,
  type Thread,
  type ThreadTurnInitiator,
  type TurnRequestTarget,
} from "@bb/domain";
import type { StartedOnBehalfOf } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import {
  appendClientTurnEvent,
  appendPreparedClientTurnRequestedEventWithNotificationInTransaction,
  buildCwdBranchEntries,
  createClientTurnRequestId,
} from "./thread-events.js";
import {
  hasLiveThreadStartInFlight,
  requestThreadStart,
} from "./thread-lifecycle.js";
import { resolveDispatchAuthor } from "./dispatch-author.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import {
  createThreadStartup,
  type ThreadForkDescriptor,
  type ThreadProvisionEnvironmentIntent,
  type ThreadProvisionContext,
} from "./thread-startup-store.js";
import {
  ensureThreadProvisionEnvironmentReady,
  ensureWorkspaceReadyEvent,
  failThreadProvisioning,
  loadActiveThreadProvisionContext,
  type ThreadProvisioningDeps,
} from "./thread-provisioning-environment.js";
import {
  clearThreadProvisionSchedule,
  getThreadProvisionContext,
  saveThreadProvisionContext,
  readThreadProvisionContext,
} from "./thread-startup-store.js";
import { applyLoggedThreadLifecycleEvent } from "./lifecycle-outcome.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { recordAcceptedPromptHistoryEntry } from "../prompt-history.js";

interface RequestThreadProvisionArgs {
  environmentIntent: ThreadProvisionEnvironmentIntent;
  execution: ResolvedThreadExecutionOptions;
  fork: ThreadForkDescriptor | null;
  input: PromptInput[];
  providerInput?: PromptInput[];
  startedOnBehalfOf: StartedOnBehalfOf | null;
  thread: Thread;
  titleProvided: boolean;
}

interface RequestThreadTargetReprovisionArgs {
  beforeRequestAppendInTransaction?: (args: { tx: DbTransaction }) => void;
  environment: EnvironmentRow;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  initiator: ThreadTurnInitiator;
  senderThreadId: string | null;
  systemMessageKind?: SystemMessageKind;
  systemMessageSubject?: SystemMessageSubject | null;
  provider: {
    environmentProviderId: string;
    selection: EnvironmentProviderSelection;
  };
  thread: Thread;
}

interface AdvanceThreadProvisioningArgs {
  threadId: string;
}

interface CurrentProvisioningFailureThreadArgs {
  context: ThreadProvisionContext;
  threadId: string;
}

interface EnvironmentPayloadThreadArgs {
  context: ThreadProvisionContext;
  environment: EnvironmentRow;
  thread: Thread;
}

const ACCOUNT_AUTO_RESOLUTION_CHECK_DELAY_MS = 5_000;
// A real first turn can easily run well past the account-pool hub's own
// upstream request before the model responds (slow reasoning turns commonly
// take a minute or more) — a two-attempt/8s window observed the model's
// real, successful reply land while this check had already given up, so the
// account never got pinned even though execution genuinely succeeded. 24
// attempts at 5s covers 2 minutes, comfortably inside the account-pool
// resolution record's own 5-minute TTL, without polling indefinitely.
const ACCOUNT_AUTO_RESOLUTION_MAX_ATTEMPTS = 24;

// ponytail: a fire-and-forget poll rather than an event-driven hook, since
// there is no existing "thread reached running state" signal reachable from
// here without touching hot per-turn lifecycle paths (explicitly out of
// scope). The double-write guard makes an extra or skipped poll harmless.
function scheduleAccountAutoResolutionCheck(
  deps: ThreadProvisioningDeps,
  threadId: string,
  attempt = 0,
): void {
  const timer = setTimeout(() => {
    void checkAccountAutoResolution(deps, threadId, attempt).catch((error) => {
      deps.logger.debug(
        { err: error, threadId },
        "Account auto-resolution check failed",
      );
    });
  }, ACCOUNT_AUTO_RESOLUTION_CHECK_DELAY_MS);
  timer.unref?.();
}

export async function checkAccountAutoResolution(
  deps: ThreadProvisioningDeps,
  threadId: string,
  attempt: number,
): Promise<void> {
  const alreadyPinned = getThreadAccountState(deps.db, threadId);
  // The thread may have been deleted, or explicitly (re)pinned by the user,
  // since this poll was scheduled — stop polling rather than burn the full
  // window on a thread that no longer needs (or wants) auto-resolution.
  if (alreadyPinned === null || alreadyPinned.accountKey !== null) return;
  const rpc = createAccountPoolHttpRpcClient({
    serverUrl: `http://127.0.0.1:${deps.config.serverPort}`,
  });
  const result = (await rpc.call("account.getResolved", { threadId })) as {
    accountKey: string | null;
  };
  if (result.accountKey === null) {
    if (attempt < ACCOUNT_AUTO_RESOLUTION_MAX_ATTEMPTS - 1) {
      scheduleAccountAutoResolutionCheck(deps, threadId, attempt + 1);
    }
    return;
  }
  const current = getThreadAccountState(deps.db, threadId);
  if (current === null || current.accountKey !== null) return;
  setThreadAccount(deps.db, {
    threadId,
    accountKey: result.accountKey,
    accountResolved: true,
  });
}

function getCurrentProvisioningFailureThread(
  deps: Pick<AppDeps, "db">,
  args: CurrentProvisioningFailureThreadArgs,
): Thread | null {
  const currentThread = getThread(deps.db, args.threadId);
  if (!currentThread || currentThread.deletedAt !== null) {
    clearThreadProvisionSchedule(args.threadId);
    return null;
  }
  if (
    currentThread.status !== "starting" ||
    currentThread.archivedAt !== null
  ) {
    clearThreadProvisionSchedule(args.threadId);
    return null;
  }

  const activeContext = getThreadProvisionContext(deps.db, args.threadId);
  if (
    activeContext === null ||
    activeContext.state.provisioningId !== args.context.state.provisioningId
  ) {
    return null;
  }

  return currentThread;
}

async function startThreadIfEnvironmentReady(
  deps: ThreadProvisioningDeps,
  args: EnvironmentPayloadThreadArgs,
): Promise<void> {
  if (args.environment.status === "error") {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: "Environment provisioning failed",
    });
    return;
  }
  if (args.environment.status === "provisioning") {
    return;
  }
  if (args.environment.status !== "ready") {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: `Environment is ${args.environment.status}`,
    });
    return;
  }
  if (!args.environment.path) {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: "Environment is ready without a workspace path",
    });
    return;
  }

  const workspaceReady = ensureWorkspaceReadyEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    entries: buildCwdBranchEntries({
      path: args.environment.path,
      branchName: args.environment.branchName,
      headSha: null,
    }),
  });
  if (!workspaceReady) {
    throw new Error("Thread did not reach workspace-ready provisioning state");
  }

  // The workspace exists, so anything that queued waiting for it stops
  // waiting here rather than after the dispatch below: the wait is over at
  // this line, and the `run.succeeded` branch below returns without
  // dispatching anything. A thread with nothing queued no-ops.
  requestQueuedMessageDispatch(deps, {
    kind: "workspace-ready",
    threadId: args.thread.id,
  });

  if (
    args.context.request.seedWithoutRun &&
    args.context.request.fork === null
  ) {
    const outcome = applyLoggedThreadLifecycleEvent(deps, {
      threadId: args.thread.id,
      event: { type: "run.succeeded" },
    });
    if (!outcome.applied) {
      deps.logger.warn(
        { threadId: args.thread.id },
        "Seed-without-run thread was no longer starting; idle settle skipped",
      );
    }
    return;
  }

  await requestThreadStart(deps, {
    thread: args.thread,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      status: args.environment.status,
    },
    fork: args.context.request.fork,
    input: args.context.request.input,
    ...(args.context.request.inputGroups !== undefined
      ? { inputGroups: args.context.request.inputGroups }
      : {}),
    requestId: args.context.request.clientRequestId,
    execution: args.context.request.execution,
    permissionEscalation: resolvePermissionEscalation({
      initiator: "user",
    }),
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    syncGeneratedTitle: !args.context.request.titleProvided,
  });
  if (getThreadAccountState(deps.db, args.thread.id)?.accountKey === null) {
    scheduleAccountAutoResolutionCheck(deps, args.thread.id);
  }
}

export function requestThreadProvision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadProvisionArgs,
): ThreadProvisionContext {
  return deps.db.transaction(() => {
    const { initiator, senderThreadId } = resolveDispatchAuthor({
      retrying: false,
      senderThreadId: null,
      startedOnBehalfOf: args.startedOnBehalfOf,
    });
    const target: TurnRequestTarget = { kind: "thread-start" };
    const request = appendClientTurnEvent(deps, {
      threadId: args.thread.id,
      environmentId: args.thread.environmentId,
      type: "client/turn/requested",
      input: args.input,
      execution: args.execution,
      initiator,
      senderThreadId,
      requestMethod: "thread/start",
      source: "spawn",
      target,
    });
    recordAcceptedPromptHistoryEntry(deps, {
      thread: args.thread,
      input: args.input,
      initiator,
      target,
      requestSequence: request.sequence,
    });
    appendClientTurnEvent(deps, {
      threadId: args.thread.id,
      environmentId: args.thread.environmentId,
      type: "client/thread/start",
      initiator,
      requestMethod: "thread/start",
      source: "spawn",
    });

    const context = createThreadStartup({
      ...args,
      clientRequestId: request.requestId,
      input: args.providerInput ?? args.input,
      seedWithoutRun: args.startedOnBehalfOf !== null,
    });
    saveThreadProvisionContext({
      replace: true,
      db: deps.db,
      threadId: args.thread.id,
      context,
    });
    return context;
  });
}

export function requestThreadTargetReprovision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadTargetReprovisionArgs,
): ThreadProvisionContext {
  return deps.db.transaction(() => {
    const request = appendReprovisionTurnRequest(deps, args);
    const context = createThreadStartup({
      clientRequestId: request.requestId,
      environmentIntent:
        args.environment.status === "error" &&
        args.environment.path !== null &&
        args.environment.teardownStatus === null
          ? { type: "reuse", environmentId: args.environment.id }
          : {
              type: "provider",
              environmentProviderId: args.provider.environmentProviderId,
              machine: {
                type: "existing",
                hostId: args.environment.hostId,
              },
              inputs: args.provider.selection.inputs,
              selectionResolved: true,
            },
      execution: args.execution,
      fork: null,
      input: args.input,
      ...(args.inputGroups !== undefined
        ? { inputGroups: args.inputGroups }
        : {}),
      seedWithoutRun: false,
      titleProvided: true,
    });
    saveThreadProvisionContext({
      replace: true,
      db: deps.db,
      threadId: args.thread.id,
      context,
    });
    return context;
  });
}

function appendReprovisionTurnRequest(
  deps: Pick<AppDeps, "db" | "hub">,
  args: Omit<RequestThreadTargetReprovisionArgs, "provider">,
) {
  const requestId = createClientTurnRequestId();
  const request = deps.db.transaction(
    (tx) => {
      args.beforeRequestAppendInTransaction?.({ tx });
      const request =
        appendPreparedClientTurnRequestedEventWithNotificationInTransaction(
          tx,
          {
            threadId: args.thread.id,
            environmentId: args.environment.id,
            type: "client/turn/requested",
            input: args.input,
            ...(args.inputGroups !== undefined
              ? { inputGroups: args.inputGroups }
              : {}),
            execution: args.execution,
            initiator: args.initiator,
            senderThreadId: args.senderThreadId,
            systemMessageKind: args.systemMessageKind,
            systemMessageSubject: args.systemMessageSubject,
            requestMethod: "turn/start",
            source: "tell",
            target: { kind: "new-turn" },
            requestId,
          },
        );
      recordAcceptedPromptHistoryEntry(
        { db: tx },
        {
          thread: args.thread,
          input: args.input,
          initiator: args.initiator,
          target: { kind: "new-turn" },
          requestSequence: request.sequence,
        },
      );
      return request;
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(
    args.thread.id,
    request.notificationChanges,
    request.notificationMetadata,
  );
  return request;
}

async function advanceThreadProvisioningOnce(
  deps: ThreadProvisioningDeps,
  args: AdvanceThreadProvisioningArgs,
): Promise<void> {
  const thread = getThread(deps.db, args.threadId);
  if (
    !thread ||
    thread.deletedAt !== null ||
    hasLiveThreadStartInFlight(thread.id)
  ) {
    return;
  }
  if (thread.status !== "starting") {
    clearThreadProvisionSchedule(thread.id);
    return;
  }
  let context = loadActiveThreadProvisionContext(deps, thread.id);
  if (!context) {
    failThreadProvisioning(deps, {
      thread,
      environmentId: thread.environmentId,
      detail: "Thread setup did not finish. Retry the thread to continue.",
    });
    return;
  }
  if (thread.archivedAt !== null) {
    return;
  }

  try {
    const ready = await ensureThreadProvisionEnvironmentReady(deps, {
      context,
      thread,
    });
    if (ready === null) {
      return;
    }
    context = ready.context;
    await startThreadIfEnvironmentReady(deps, {
      context: ready.context,
      environment: ready.environment,
      thread: ready.thread,
    });
  } catch (error) {
    const failureThread = getCurrentProvisioningFailureThread(deps, {
      context,
      threadId: thread.id,
    });
    if (!failureThread) {
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    failThreadProvisioning(deps, {
      thread: failureThread,
      environmentId: context.state.environmentId ?? failureThread.environmentId,
      detail,
    });
  }
}

export async function advanceThreadProvisioning(
  deps: ThreadProvisioningDeps,
  args: AdvanceThreadProvisioningArgs,
): Promise<void> {
  await deps.lifecycleDedupers.threadProvisionAdvance.run(args.threadId, () =>
    advanceThreadProvisioningOnce(deps, args),
  );
}

/**
 * Drives provisioning off the caller's stack. Creation returns the thread row
 * before the workspace exists, and a cold-start row whose wait cleared returns
 * to its sweep or route the same way, so neither waits on the daemon.
 */
export function scheduleThreadProvisioningAdvance(
  deps: ThreadProvisioningDeps & Pick<AppDeps, "config" | "logger">,
  threadId: string,
): void {
  void advanceThreadProvisioning(deps, {
    threadId,
  }).catch((error) => {
    deps.logger.warn(
      {
        threadId,
        ...runtimeErrorLogFields(deps.config, error),
      },
      "Failed to advance thread provisioning",
    );
  });
}

export async function restoreInterruptedThreadStartupRequest(
  deps: ThreadProvisioningDeps,
  threadId: string,
): Promise<ThreadProvisionContext["request"] | null> {
  const context = readThreadProvisionContext(deps.db, threadId);
  if (context === null) return null;
  const provisioning = getPreparingEnvironment(deps.db, threadId);
  if (provisioning !== null) {
    await cancelProviderEnvironmentCreation(deps, threadId);
  }
  const machine = getNonDestroyedHostByLaunchKey(deps.db, threadId);
  if (machine?.phase === "removing") {
    await sweepProviderMachine(deps, machine.id);
  }
  return context.request;
}
