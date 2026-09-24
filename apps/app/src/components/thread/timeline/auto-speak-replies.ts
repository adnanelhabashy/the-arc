import { createContext, useContext } from "react";

export const AutoSpeakRepliesContext = createContext(false);

export function useAutoSpeakReplies(): boolean {
  return useContext(AutoSpeakRepliesContext);
}
