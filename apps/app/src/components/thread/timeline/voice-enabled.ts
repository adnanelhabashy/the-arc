import { createContext, useContext } from "react";

export const VoiceEnabledContext = createContext(true);

export function useVoiceEnabled(): boolean {
  return useContext(VoiceEnabledContext);
}
