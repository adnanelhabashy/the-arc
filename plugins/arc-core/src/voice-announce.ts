import { z } from "zod";
import type {
  BbPluginApi,
  PluginAgentConfiguration,
} from "@get-bb/plugin-sdk";

export const ARC_VOICE_SPEAK_TOOL_NAME = "arc_voice_speak";
export const ARC_VOICE_ANNOUNCE_CHANNEL = "arc-voice-announce";
export const ARC_VOICE_PLUGIN_ID = "arc-core";
export const ARC_VOICE_SPEAK_MAX_TEXT_CHARS = 1200;

const arcVoiceSpeakMetadataSchema = z
  .object({
    automationId: z.string().min(1).max(128),
    allowVoiceOutput: z.boolean(),
    providerId: z.string().min(1).max(128),
  })
  .strip();

export type ArcVoiceSpeakMetadata = z.infer<typeof arcVoiceSpeakMetadataSchema>;

export function readArcVoiceSpeakMetadata(
  value: unknown,
): ArcVoiceSpeakMetadata | null {
  const parsed = arcVoiceSpeakMetadataSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : null;
}

export interface ArcVoiceAnnouncePayload {
  text: string;
  threadId: string;
  automationId: string;
  providerId: string;
}

export interface ArcVoiceSpeakDeps {
  publish: (payload: ArcVoiceAnnouncePayload) => Promise<unknown>;
  readThreadMetadata: (threadId: string) => Promise<unknown>;
}

const TOOL_INSTRUCTIONS = [
  "Use arc_voice_speak only for short spoken alerts (at most two sentences): an urgent notice, a completion summary, or a result the user asked to hear aloud.",
  "Never pass logs, code, diffs, secrets, credentials, full documents, or message bodies; deliver those as normal visible output instead.",
  "The alert plays on the user's machine and must make sense without the thread on screen.",
].join(" ");

export function registerArcVoiceSpeakTool(args: {
  agents: Pick<BbPluginApi["agents"], "registerTool" | "configure">;
  deps: ArcVoiceSpeakDeps;
}): void {
  const { agents, deps } = args;
  agents.registerTool({
    name: ARC_VOICE_SPEAK_TOOL_NAME,
    description:
      "Speak a short voice alert through Arc Voice on the user's machine. For brief user-facing announcements only (at most two sentences); never for logs, code, diffs, or documents.",
    instructions: TOOL_INSTRUCTIONS,
    presentation: {
      label: { pending: "Speaking voice alert", completed: "Spoke voice alert" },
    },
    parameters: z
      .object({
        text: z.string().min(1).max(ARC_VOICE_SPEAK_MAX_TEXT_CHARS),
      })
      .strict(),
    async execute({ text }, context) {
      try {
        const metadata = readArcVoiceSpeakMetadata(
          await deps.readThreadMetadata(context.threadId),
        );
        if (metadata === null || metadata.allowVoiceOutput !== true) {
          return "Voice output is not enabled for this automation; nothing was spoken.";
        }
        await deps.publish({
          text,
          threadId: context.threadId,
          automationId: metadata.automationId,
          providerId: metadata.providerId,
        });
        return "Voice alert announced.";
      } catch {
        return "Voice alert could not be announced; continuing without it.";
      }
    },
  });
  agents.configure((): PluginAgentConfiguration => {
    return {
      tools: [ARC_VOICE_SPEAK_TOOL_NAME],
      skills: [],
    };
  });
}
