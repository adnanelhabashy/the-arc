import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SystemVoiceCapabilitiesResponse } from "@bb/server-contract";
import { readVoiceCapabilities, readVoiceProfiles } from "@/lib/api";
import {
  voiceCapabilitiesQueryKey,
  voiceProfilesQueryKey,
} from "@/hooks/queries/query-keys";
import {
  invalidateVoiceCapabilities,
  invalidateVoiceProfiles,
} from "@/hooks/cache-owners/system-cache-effects";

export function capabilitiesHaveDownload(
  data: SystemVoiceCapabilitiesResponse | undefined,
): boolean {
  if (data === undefined) {
    return false;
  }
  return (
    data.speechModels.some((model) => model.downloading) ||
    data.engines.some((engine) =>
      engine.models.some((model) => model.downloading),
    )
  );
}

export function useVoiceCapabilities() {
  return useQuery({
    queryKey: voiceCapabilitiesQueryKey(),
    queryFn: ({ signal }) => readVoiceCapabilities(signal),
    refetchInterval: (query) =>
      capabilitiesHaveDownload(query.state.data) ? 2000 : false,
  });
}

export function useVoiceProfiles() {
  return useQuery({
    queryKey: voiceProfilesQueryKey(),
    queryFn: ({ signal }) => readVoiceProfiles(signal),
  });
}

export function useInvalidateVoiceData() {
  const queryClient = useQueryClient();
  return () => {
    invalidateVoiceProfiles({ queryClient });
    invalidateVoiceCapabilities({ queryClient });
  };
}
