import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PRODUCT_DEFAULT_PERMISSION_MODE } from "@bb/domain";
import type { AgentEnvironment, PermissionMode } from "./rpc-types.js";

type ProviderPermissionApi = {
  sdk: {
    providers: Pick<BbPluginApi["sdk"]["providers"], "list">;
  };
};

type ProviderRouting = NonNullable<
  Parameters<ProviderPermissionApi["sdk"]["providers"]["list"]>[0]
>;

export function providerRoutingForEnvironment(
  environment: AgentEnvironment,
): ProviderRouting {
  if (environment.type === "reuse") {
    return { environmentId: environment.environmentId };
  }
  if (environment.type === "host" && environment.hostId !== undefined) {
    return { hostId: environment.hostId };
  }
  return {};
}

/**
 * The mode an automation asks for, after the one check this plugin owns: that
 * the provider it names is actually available on the target machine.
 *
 * Compatibility is deliberately *not* decided here. Which supported mode a
 * request maps to depends on the provider's capabilities and the target
 * machine's permission ceiling, and the server is the only party that knows
 * both for the environment an automation runs in. The automation stores what
 * the user asked for; the server resolves it at spawn time, exactly as it does
 * for a composer-created thread, and reports an actionable error if nothing at
 * or below the request is available.
 */
export async function resolveRequestedPermissionMode(
  bb: ProviderPermissionApi,
  providerId: string,
  requested: PermissionMode | undefined,
  routing: ProviderRouting = {},
): Promise<PermissionMode> {
  const providers = await bb.sdk.providers.list(routing);
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined || provider.available === false) {
    throw new Error(`Provider ${providerId} is not available.`);
  }
  return requested ?? PRODUCT_DEFAULT_PERMISSION_MODE;
}
