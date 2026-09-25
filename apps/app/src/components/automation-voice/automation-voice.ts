import { z } from "zod";

export const AUTOMATION_VOICE_ANNOUNCE_CHANNEL = "arc-voice-announce";

const automationVoiceAnnounceSchema = z
  .object({
    text: z.string().min(1).max(1200),
    threadId: z.string().min(1).max(128),
    automationId: z.string().min(1).max(128),
    providerId: z.string().min(1).max(128),
  })
  .strip();

export type AutomationVoiceAnnounce = z.infer<
  typeof automationVoiceAnnounceSchema
>;

export function readAutomationVoiceAnnounce(
  value: unknown,
): AutomationVoiceAnnounce | null {
  const parsed = automationVoiceAnnounceSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : null;
}
