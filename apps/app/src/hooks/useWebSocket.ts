import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createRealtimeCacheEffects } from "./realtime-cache-effects";
import { handleArcPluginSignal } from "./cache-owners/arc-cache-owner";
import { useDeletedResourceRouteOwner } from "./cache-owners/resource-route-owner";
import { wsManager } from "../lib/ws";

export function useWebSocket(): void {
  const queryClient = useQueryClient();
  const handleDeletedResourceRouteChange = useDeletedResourceRouteOwner();
  const deletedResourceRouteChangeRef = useRef(
    handleDeletedResourceRouteChange,
  );
  deletedResourceRouteChangeRef.current = handleDeletedResourceRouteChange;

  useEffect(() => {
    const cacheEffects = createRealtimeCacheEffects({ queryClient });
    const unsubscribeConnected = wsManager.onConnected(
      cacheEffects.handleConnected,
    );
    const unsubscribe = wsManager.onChanged((message) => {
      cacheEffects.handleChanged(message);
      deletedResourceRouteChangeRef.current(message);
    });
    // Arc Core reports its own mutations on a plugin channel rather than as a
    // domain change message, so the app's Arc caches invalidate from that
    // signal instead of waiting out their staleTime.
    const unsubscribeArcChanged = wsManager.onPluginSignal((signal) => {
      handleArcPluginSignal(queryClient, signal);
    });

    wsManager.connect();

    return () => {
      cacheEffects.dispose();
      unsubscribeConnected();
      unsubscribe();
      unsubscribeArcChanged();
    };
  }, [queryClient]);
}
