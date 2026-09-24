import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Command } from "commander";
import { action } from "../action.js";
import { cliFetch, createCliBbSdk } from "../client.js";
import { outputJson } from "./helpers.js";

interface VoiceTranscribeOptions {
  json?: boolean;
  prompt?: string;
  type?: string;
}

interface VoiceSpeakOptions {
  out?: string;
}

export function registerVoiceCommands(
  program: Command,
  getUrl: () => string,
): void {
  const voice = program.command("voice").description("Voice input utilities");
  voice
    .command("transcribe <file>")
    .description("Transcribe an audio file with BB's configured voice service")
    .option("--prompt <text>", "Optional transcription context")
    .option("--type <mime>", "Audio MIME type", "audio/webm")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (path: string, opts: VoiceTranscribeOptions) => {
        const bytes = await readFile(path);
        const blob = new File([bytes], basename(path), {
          type: opts.type ?? "audio/webm",
        });
        const result = await createCliBbSdk(getUrl()).system.transcribeVoice({
          file: blob,
          ...(opts.prompt ? { prompt: opts.prompt } : {}),
        });
        if (outputJson(opts, result)) return;
        console.log(result.text);
      }),
    );

  voice
    .command("speak <text>")
    .description("Synthesize speech with BB's configured voice service")
    .option("--out <file>", "Write the returned audio to a file")
    .action(
      action(async (text: string, opts: VoiceSpeakOptions) => {
        const baseUrl = getUrl().replace(/\/$/u, "");
        const response = await cliFetch(`${baseUrl}/api/v1/system/voice-speak`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) {
          let message = `voice speak failed: HTTP ${response.status}`;
          try {
            const body = (await response.json()) as { message?: string };
            if (typeof body.message === "string" && body.message.length > 0) {
              message = body.message;
            }
          } catch {
            message = `voice speak failed: HTTP ${response.status}`;
          }
          throw new Error(message);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (opts.out !== undefined) {
          await writeFile(opts.out, bytes);
          return;
        }
        process.stdout.write(bytes);
      }),
    );
}
