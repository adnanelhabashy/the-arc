import { describe, expect, it } from "vitest";
import {
  ARC_VOICE_ANNOUNCE_CHANNEL,
  ARC_VOICE_SPEAK_MAX_TEXT_CHARS,
  ARC_VOICE_SPEAK_TOOL_NAME,
  readArcVoiceSpeakMetadata,
  registerArcVoiceSpeakTool,
  type ArcVoiceAnnouncePayload,
} from "../src/voice-announce.js";

interface CapturedTool {
  name: string;
  parameters: { safeParse: (value: unknown) => { success: boolean } };
  execute: (
    params: { text: string },
    context: { threadId: string; projectId: string; signal: AbortSignal },
  ) => Promise<unknown>;
}

function asCapturedTool(value: unknown): CapturedTool {
  if (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function" &&
    "parameters" in value &&
    typeof value === "object" &&
    value.parameters !== null &&
    typeof (value.parameters as { safeParse?: unknown }).safeParse === "function"
  ) {
    // Structurally narrowed above; the interface mirrors the SDK's registration
    // shape, which inference cannot unify across the registerTool overloads.
    return value as CapturedTool;
  }
  throw new Error("registered tool does not match the expected shape");
}

function selectedToolNames(configuration: unknown): string[] {
  if (
    typeof configuration === "object" &&
    configuration !== null &&
    "tools" in configuration &&
    Array.isArray(configuration.tools)
  ) {
    return configuration.tools.filter(
      (tool): tool is string => typeof tool === "string",
    );
  }
  return [];
}

function createHarness(options: {
  metadata?: unknown;
  metadataError?: unknown;
} = {}) {
  const captured: {
    tool?: unknown;
    configure?: (context: unknown) => unknown;
  } = {};
  const published: ArcVoiceAnnouncePayload[] = [];
  registerArcVoiceSpeakTool({
    agents: {
      registerTool: (registration: unknown) => {
        captured.tool = registration;
      },
      configure: (provider) => {
        captured.configure = provider as (context: unknown) => unknown;
      },
    },
    deps: {
      publish: async (payload) => {
        published.push(payload);
      },
      readThreadMetadata: async () => {
        if ("metadataError" in options) throw options.metadataError;
        return options.metadata;
      },
    },
  });
  if (captured.tool === undefined || captured.configure === undefined) {
    throw new Error("tool or configure was not registered");
  }
  const tool = asCapturedTool(captured.tool);
  return {
    tool,
    published,
    selectTools: (pluginMetadata: unknown): string[] =>
      selectedToolNames(captured.configure?.({ pluginMetadata })),
    execute: (text: string, threadId = "thr_1") =>
      tool.execute(
        { text },
        {
          threadId,
          projectId: "prj_1",
          signal: new AbortController().signal,
        },
      ),
  };
}

const TOOL_CONTEXT_METADATA = {
  automationId: "auto_1",
  allowVoiceOutput: true,
  providerId: "codex",
};

describe("wire constants", () => {
  it("pins the tool name and announce channel the renderer mirrors", () => {
    expect(ARC_VOICE_SPEAK_TOOL_NAME).toBe("arc_voice_speak");
    expect(ARC_VOICE_ANNOUNCE_CHANNEL).toBe("arc-voice-announce");
  });
});

describe("readArcVoiceSpeakMetadata", () => {
  it("accepts the stamped automation metadata", () => {
    expect(readArcVoiceSpeakMetadata(TOOL_CONTEXT_METADATA)).toEqual(
      TOOL_CONTEXT_METADATA,
    );
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a string", "yes"],
    [
      "allowVoiceOutput as a string",
      { ...TOOL_CONTEXT_METADATA, allowVoiceOutput: "true" },
    ],
    ["allowVoiceOutput as a number", { ...TOOL_CONTEXT_METADATA, allowVoiceOutput: 1 }],
    ["empty automationId", { ...TOOL_CONTEXT_METADATA, automationId: "" }],
    ["missing providerId", { automationId: "auto_1", allowVoiceOutput: true }],
    [
      "oversized automationId",
      { ...TOOL_CONTEXT_METADATA, automationId: "x".repeat(129) },
    ],
  ])("rejects %s", (_name, value) => {
    expect(readArcVoiceSpeakMetadata(value)).toBeNull();
  });

  it("keeps additional keys out of the result", () => {
    expect(
      readArcVoiceSpeakMetadata({
        ...TOOL_CONTEXT_METADATA,
        extra: "dropped",
      }),
    ).toEqual(TOOL_CONTEXT_METADATA);
  });
});

describe("configure", () => {
  it("always selects the tool; the execute-time gate is authoritative", () => {
    const { selectTools } = createHarness();

    expect(selectTools(TOOL_CONTEXT_METADATA)).toEqual([
      ARC_VOICE_SPEAK_TOOL_NAME,
    ]);
    expect(selectTools({})).toEqual([ARC_VOICE_SPEAK_TOOL_NAME]);
    expect(selectTools(null)).toEqual([ARC_VOICE_SPEAK_TOOL_NAME]);
  });
});

describe("arc_voice_speak execute", () => {
  it("publishes the validated announcement payload", async () => {
    const { execute, published } = createHarness({
      metadata: TOOL_CONTEXT_METADATA,
    });

    const result = await execute("Build finished with two failures.");

    expect(result).toBe("Voice alert announced.");
    expect(published).toEqual([
      {
        text: "Build finished with two failures.",
        threadId: "thr_1",
        automationId: "auto_1",
        providerId: "codex",
      },
    ]);
  });

  it("refuses without publishing when the fresh read shows voice disabled", async () => {
    const { execute, published } = createHarness({
      metadata: { ...TOOL_CONTEXT_METADATA, allowVoiceOutput: false },
    });

    const result = await execute("hello");

    expect(result).toBe(
      "Voice output is not enabled for this automation; nothing was spoken.",
    );
    expect(published).toEqual([]);
  });

  it("refuses without publishing on malformed fresh metadata", async () => {
    const { execute, published } = createHarness({
      metadata: { allowVoiceOutput: "true" },
    });

    const result = await execute("hello");

    expect(result).toBe(
      "Voice output is not enabled for this automation; nothing was spoken.",
    );
    expect(published).toEqual([]);
  });

  it("never throws when the metadata read fails", async () => {
    const { execute, published } = createHarness({
      metadataError: new Error("loopback down"),
    });

    const result = await execute("hello");

    expect(result).toBe(
      "Voice alert could not be announced; continuing without it.",
    );
    expect(published).toEqual([]);
  });

  it("never throws when publishing fails", async () => {
    const captured: { tool?: unknown } = {};
    registerArcVoiceSpeakTool({
      agents: {
        registerTool: (registration: unknown) => {
          captured.tool = registration;
        },
        configure: () => undefined,
      },
      deps: {
        publish: async () => {
          throw new Error("ws down");
        },
        readThreadMetadata: async () => TOOL_CONTEXT_METADATA,
      },
    });
    if (captured.tool === undefined) throw new Error("tool was not registered");
    const tool = asCapturedTool(captured.tool);

    const result = await tool.execute(
      { text: "hello" },
      {
        threadId: "thr_1",
        projectId: "prj_1",
        signal: new AbortController().signal,
      },
    );

    expect(result).toBe(
      "Voice alert could not be announced; continuing without it.",
    );
  });
});

describe("arc_voice_speak parameters", () => {
  it(`caps text at ${String(ARC_VOICE_SPEAK_MAX_TEXT_CHARS)} characters`, () => {
    const { tool } = createHarness();

    expect(
      tool.parameters.safeParse({
        text: "x".repeat(ARC_VOICE_SPEAK_MAX_TEXT_CHARS),
      }).success,
    ).toBe(true);
    expect(
      tool.parameters.safeParse({
        text: "x".repeat(ARC_VOICE_SPEAK_MAX_TEXT_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(tool.parameters.safeParse({ text: "" }).success).toBe(false);
    expect(tool.parameters.safeParse({ text: "hi", extra: 1 }).success).toBe(
      false,
    );
  });
});
