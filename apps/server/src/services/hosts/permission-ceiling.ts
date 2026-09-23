import { getEnvironment, getHost } from "@bb/db";
import {
  describePermissionModeUnsupported,
  resolveEffectivePermissionMode,
  type PermissionMode,
  type PermissionModeResolution,
  type ResolveEffectivePermissionModeArgs,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import { ProviderCapabilityError } from "../providers/provider-capability-error.js";
import type { AppDeps } from "../../types.js";

type PermissionCeilingDeps = Pick<AppDeps, "db">;

export function getHostPermissionCeiling(
  deps: PermissionCeilingDeps,
  hostId: string | null,
): PermissionMode {
  if (hostId === null) return "full";
  return getHost(deps.db, hostId)?.maxPermissionMode ?? "full";
}

export function resolveEnvironmentHostId(
  deps: PermissionCeilingDeps,
  environmentId: string | null,
): string | null {
  if (environmentId === null) return null;
  return getEnvironment(deps.db, environmentId)?.hostId ?? null;
}

export interface ResolveProviderPermissionModeArgs
  extends Omit<
    ResolveEffectivePermissionModeArgs,
    "hostPermissionCeiling" | "providerSupportedModes"
  > {
  hostId: string | null;
}

class HostPermissionCeilingConflictError extends ApiError {}

export function isHostPermissionCeilingConflictError(
  error: unknown,
): error is HostPermissionCeilingConflictError {
  return error instanceof HostPermissionCeilingConflictError;
}

/**
 * The server's single permission boundary. Every thread execution — new,
 * resumed, forked, child, handoff, workflow worker, automation — resolves
 * through here, so the host ceiling and provider capability are applied once,
 * in one order, for every caller.
 */
function resolveProviderPermissionMode(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: ResolveProviderPermissionModeArgs,
): PermissionModeResolution {
  return resolveEffectivePermissionMode({
    ...args,
    providerSupportedModes: deps.providerRegistry.getSupportedPermissionModes(
      args.providerId,
    ),
    hostPermissionCeiling: getHostPermissionCeiling(deps, args.hostId),
  });
}

export function requireProviderPermissionMode(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: ResolveProviderPermissionModeArgs,
): PermissionMode {
  const resolution = resolveProviderPermissionMode(deps, args);
  if (resolution.kind === "resolved") {
    return resolution.mode;
  }
  const message = describePermissionModeUnsupported(resolution);
  throw resolution.reason === "ceiling"
    ? new HostPermissionCeilingConflictError(
        400,
        "host_permission_ceiling_conflict",
        message,
      )
    : new ProviderCapabilityError(400, "invalid_request", message);
}
