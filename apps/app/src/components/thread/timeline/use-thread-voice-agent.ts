import { useThreadProvider } from "../thread-provider-context.js";
import { providerIdToAgentId } from "./ProviderUsageSection.js";
import type { MessageSpeechAgentId } from "./message-speech.js";

export function useThreadVoiceAgent(): MessageSpeechAgentId | null {
  const { providerId } = useThreadProvider();
  return providerIdToAgentId(providerId ?? undefined);
}
