import { getEnvironmentProvider } from "../plugins/plugin-environment-provider-registry.js";
import type {
  ProjectExecutionDefaults,
  ReasoningLevel,
  ServiceTier,
} from "@bb/domain";
import { getEnvironment } from "@bb/db";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../environments/environment-provider-ids.js";
import { PERSONAL_PROJECT_ID, PRODUCT_DEFAULT_PERMISSION_MODE } from "@bb/domain";
import type {
  EnvironmentArgs,
  ProviderEnvironmentArgs,
} from "@bb/server-contract";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { WorkSessionDeps } from "../../types.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { ApiError } from "../../errors.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { requireConnectedPrimaryHostId } from "../hosts/primary-host.js";
import { resolveProjectWorkspaceTarget } from "../projects/project-workspace.js";
import { resolveDefaultWorktreeBaseBranch } from "../projects/worktree-base-branch.js";
import {
  checkoutProviderInputs,
  worktreeProviderInputs,
} from "./thread-environment-placement.js";
import { isLiveParentThread, type ParentThread } from "./thread-parent.js";

export const DEFAULT_SERVICE_TIER: ServiceTier = "default";
export const DEFAULT_REASONING_LEVEL: ReasoningLevel = "medium";

function listDefaultProviderIdCandidates(
  registry: ProviderRegistryService,
): string[] {
  const available = registry
    .list()
    .filter((registration) => registration.info.available)
    .map((registration) => registration.info.id);
  const preferred = registry.getUserDefaultProviderId();
  if (preferred !== null && available.includes(preferred)) {
    return [preferred, ...available.filter((id) => id !== preferred)];
  }
  return available;
}

function requireDefaultProviderId(registry: ProviderRegistryService): string {
  const providerId = listDefaultProviderIdCandidates(registry)[0];
  if (providerId === undefined) {
    throw new ApiError(
      409,
      "no_provider_available",
      "No agent provider is enabled. Enable an agent provider plugin in Settings → Plugins to start a thread.",
    );
  }
  return providerId;
}

interface ResolveCreateThreadExecutionDefaultsArgs {
  requestedProviderId?: string;
  storedDefaults: ProjectExecutionDefaults | null;
}

interface CreateThreadExecutionDefaultsResolved {
  executionDefaults: ProjectExecutionDefaults | null;
  providerId: string;
  providerFallbackCandidates: readonly string[];
}

interface ResolveCreateThreadEnvironmentArgs {
  parentThread: ParentThread | null;
  projectId: string;
  requestedEnvironment: CreateThreadEnvironment;
}

type CreateThreadEnvironment =
  | EnvironmentArgs
  | ProviderEnvironmentArgs
  | { type: "project-default" };
export type ResolvedCreateThreadEnvironment = Exclude<
  CreateThreadEnvironment,
  { type: "project-default" }
>;

type ImplicitHostDefaultEnvironment = Extract<
  EnvironmentArgs,
  { type: "host" }
> & {
  workspace: { path: null; type: "unmanaged" };
};

function isImplicitHostDefaultEnvironment(
  environment: ResolvedCreateThreadEnvironment,
): environment is ImplicitHostDefaultEnvironment {
  return (
    environment.type === "host" &&
    environment.workspace.type === "unmanaged" &&
    environment.workspace.path === null
  );
}

function isPersonalWorkspaceEnvironment(
  environment: CreateThreadEnvironment,
): boolean {
  return (
    environment.type === "project-default" ||
    (environment.type === "host" &&
      environment.workspace.type === "personal") ||
    (environment.type === "provider" &&
      environment.environmentProviderId ===
        DEFAULT_ENVIRONMENT_PROVIDER_ID.personalWorkspace)
  );
}

function requireHostEnvironmentId(
  environment: Extract<EnvironmentArgs, { type: "host" }>,
): string {
  if (environment.hostId !== undefined) {
    return environment.hostId;
  }
  throw new Error("Host environment is missing hostId");
}

export function resolveCreateThreadExecutionDefaults(
  registry: ProviderRegistryService,
  args: ResolveCreateThreadExecutionDefaultsArgs,
): CreateThreadExecutionDefaultsResolved {
  const isProductDefault =
    args.requestedProviderId === undefined &&
    args.storedDefaults?.providerId === undefined;
  const defaultCandidates = isProductDefault
    ? listDefaultProviderIdCandidates(registry)
    : [];
  const providerId =
    args.requestedProviderId ??
    args.storedDefaults?.providerId ??
    requireDefaultProviderId(registry);
  const registration = registry.get(providerId);
  if (registration !== null && !registration.info.available) {
    throw new ApiError(
      409,
      "provider_unavailable",
      `${registration.info.displayName} is unavailable because its provider plugin failed to load.`,
    );
  }

  const storedDefaults =
    args.storedDefaults?.providerId === providerId ? args.storedDefaults : null;
  return {
    executionDefaults: storedDefaults,
    providerId,
    providerFallbackCandidates: defaultCandidates.filter(
      (id) => id !== providerId,
    ),
  };
}

export function buildProviderThreadExecutionDefaults(
  args: {
    model: string;
    providerId: string;
  },
): ProjectExecutionDefaults {
  return {
    providerId: args.providerId,
    model: args.model,
    reasoningLevel: DEFAULT_REASONING_LEVEL,
    permissionMode: PRODUCT_DEFAULT_PERMISSION_MODE,
    serviceTier: DEFAULT_SERVICE_TIER,
  };
}

function requireDefaultEnvironmentProvider(id: string): string {
  if (getEnvironmentProvider(id) === undefined) {
    throw new ApiError(
      409,
      "environment_provider_rejected",
      `The default environment provider "${id}" is unavailable. Enable its plugin or explicitly choose another environment.`,
    );
  }
  return id;
}

export async function resolveProjectDefaultThreadEnvironment(
  deps: WorkSessionDeps,
  args: { projectId: string },
): Promise<ResolvedCreateThreadEnvironment> {
  if (args.projectId === PERSONAL_PROJECT_ID) {
    return {
      type: "provider",
      environmentProviderId: requireDefaultEnvironmentProvider(
        DEFAULT_ENVIRONMENT_PROVIDER_ID.personalWorkspace,
      ),
      machine: {
        type: "existing",
        hostId: requireConnectedPrimaryHostId(deps),
      },
      inputs: null,
    };
  }

  const hostId = requireConnectedPrimaryHostId(deps);
  const source = resolveProjectWorkspaceTarget(deps, {
    hostId,
    projectId: args.projectId,
  });
  const checkout = await callHostRetryableOnlineRpc(deps, {
    hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.inspect_git_source",
      path: source.path,
      remoteRefresh: "background",
    },
  });
  const baseBranch = resolveDefaultWorktreeBaseBranch(checkout);
  if (baseBranch === null) {
    return {
      type: "provider",
      environmentProviderId: requireDefaultEnvironmentProvider(
        DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout,
      ),
      machine: { type: "existing", hostId },
      inputs: checkoutProviderInputs(source.path, undefined),
    };
  }

  return {
    type: "provider",
    environmentProviderId: requireDefaultEnvironmentProvider(
      DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
    ),
    machine: { type: "existing", hostId },
    inputs: worktreeProviderInputs({ kind: "named", name: baseBranch }),
  };
}

export async function resolveCreateThreadEnvironment(
  deps: WorkSessionDeps,
  args: ResolveCreateThreadEnvironmentArgs,
): Promise<ResolvedCreateThreadEnvironment> {
  const parentThread = args.parentThread;
  const hasLiveParent = isLiveParentThread({ parentThread });
  if (
    hasLiveParent &&
    parentThread?.projectId === PERSONAL_PROJECT_ID &&
    args.projectId === PERSONAL_PROJECT_ID &&
    isPersonalWorkspaceEnvironment(args.requestedEnvironment)
  ) {
    if (!parentThread.environmentId) {
      throw new Error("Personal parent thread is missing an environment");
    }
    return { type: "reuse", environmentId: parentThread.environmentId };
  }
  if (
    hasLiveParent &&
    parentThread?.projectId === args.projectId &&
    args.projectId !== PERSONAL_PROJECT_ID &&
    args.requestedEnvironment.type === "project-default"
  ) {
    if (!parentThread.environmentId) {
      throw new Error("Parent thread is missing an environment");
    }
    const parentEnvironment = getEnvironment(
      deps.db,
      parentThread.environmentId,
    );
    if (parentEnvironment === null) {
      throw new Error("Parent thread environment is missing");
    }
    return {
      type: "provider",
      environmentProviderId: requireDefaultEnvironmentProvider(
        DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
      ),
      machine: { type: "existing", hostId: parentEnvironment.hostId },
      inputs: worktreeProviderInputs({ kind: "default" }),
    };
  }
  const environment =
    args.requestedEnvironment.type === "project-default"
      ? await resolveProjectDefaultThreadEnvironment(deps, {
          projectId: args.projectId,
        })
      : args.requestedEnvironment;

  if (
    args.projectId === PERSONAL_PROJECT_ID &&
    isImplicitHostDefaultEnvironment(environment)
  ) {
    return {
      type: "provider",
      environmentProviderId: requireDefaultEnvironmentProvider(
        DEFAULT_ENVIRONMENT_PROVIDER_ID.personalWorkspace,
      ),
      machine: {
        type: "existing",
        hostId: requireHostEnvironmentId(environment),
      },
      inputs: null,
    };
  }

  if (hasLiveParent && isImplicitHostDefaultEnvironment(environment)) {
    return {
      type: "provider",
      environmentProviderId: requireDefaultEnvironmentProvider(
        DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
      ),
      machine: {
        type: "existing",
        hostId: requireHostEnvironmentId(environment),
      },
      inputs: worktreeProviderInputs({ kind: "default" }),
    };
  }
  if (
    hasLiveParent &&
    environment.type === "provider" &&
    environment.environmentProviderId ===
      DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout &&
    args.requestedEnvironment.type === "project-default"
  ) {
    return {
      type: "provider",
      environmentProviderId: requireDefaultEnvironmentProvider(
        DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
      ),
      machine: environment.machine,
      inputs: worktreeProviderInputs({ kind: "default" }),
    };
  }

  return environment;
}
