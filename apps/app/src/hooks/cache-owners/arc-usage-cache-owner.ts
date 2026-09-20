import type { QueryClient } from "@tanstack/react-query";

const ARC_CURRENT_AGENT_USAGE_QUERY_KEY = "arcCurrentAgentUsage" as const;

export function invalidateArcCurrentAgentUsage(
  queryClient: QueryClient,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: [ARC_CURRENT_AGENT_USAGE_QUERY_KEY],
  });
}
