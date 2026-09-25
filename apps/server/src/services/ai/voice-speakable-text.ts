export const MAX_SPEAK_TEXT_CHARS = 1200;
export const BRIEF_SPEAK_TEXT_CHARS = 400;
export const FULL_SPEAK_TEXT_CHARS = 4000;

export type VoiceSpeakDetail = "brief" | "balanced" | "full";

export function speakDetailCap(detail: VoiceSpeakDetail): number {
  switch (detail) {
    case "brief":
      return BRIEF_SPEAK_TEXT_CHARS;
    case "full":
      return FULL_SPEAK_TEXT_CHARS;
    case "balanced":
      return MAX_SPEAK_TEXT_CHARS;
  }
}

export interface SpeakableText {
  text: string;
  truncated: boolean;
}

const FENCE = /^(?:```|~~~)/u;
const DIFF_MARKER = /^(?:diff --git|index |--- |\+\+\+ |@@ )/u;
const HUNK_LINE = /^[+ -]/u;
const STACK_FRAME = /^\s*at\s+.+:\d+:\d+/u;
const TRACEBACK = /^Traceback\s*\(/u;
const TRACE_FRAME = /^\s+(?:File\s+"|at\s|line\s+\d+\b)/u;
const TRACE_EXCEPTION =
  /^[A-Za-z_][\w.]*(?:Error|Exception|Warning|Interrupt|Exit)\b/u;
const INTERNAL_PREFIX =
  /^(?:ANALYSIS|REASONING|THOUGHTS?|PLAN|SCRATCHPAD|NOTE TO SELF)\s*:/iu;
const INTERNAL_TAG_REGION =
  /<\s*(?:system|tool_call|tool-call|tool|analysis|reasoning|thinking|scratchpad|workflow)[^>]*>[\s\S]*?<\s*\/\s*(?:system|tool_call|tool-call|tool|analysis|reasoning|thinking|scratchpad|workflow)\s*>/giu;
const INLINE_INTERNAL =
  /\b(?:ANALYSIS|REASONING|THOUGHTS?|PLAN|SCRATCHPAD|NOTE TO SELF)\s*:\s*\S+/giu;
const TOOL_BRACKET =
  /\[(?:tool|tool_call|tool_use|function_call|tool_result)[^\]]*\]/giu;
const HTML_TAG = /<\/?[A-Za-z][^>]*>/gu;
const JSON_LINE = /^(?:\{.*\}|\[.*\])\s*$/u;
const KEY_VALUE_DUMP = /^[A-Za-z_][A-Za-z0-9_.-]*\s*:\s*\S+.*$/u;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|?\s*$/u;

function cleanInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/`+/gu, "")
    .replace(/\*\*/gu, "")
    .replace(/__/gu, "")
    .replace(/\B[_*]\B/gu, "")
    .replace(/^\s*#{1,6}\s*/u, "")
    .replace(/^\s*>\s?/u, "")
    .replace(/^\s*[-+*]\s+/u, "")
    .replace(/\|/gu, " ");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function mostlyPunctuation(line: string): boolean {
  return !/[\p{L}\p{N}]/u.test(line);
}

function truncateSpeakable(text: string, cap: number): SpeakableText {
  if (text.length <= cap) {
    return { text, truncated: false };
  }
  const head = text.slice(0, cap);
  const sentence = /^[\s\S]*[.!?](?=\s|$)/u.exec(head);
  const cut =
    sentence === null ? head.replace(/\S+\s*$/u, "") : sentence[0];
  const trimmed = cut.trimEnd();
  return {
    text: trimmed.length > 0 ? trimmed : head,
    truncated: true,
  };
}

export function deriveSpeakableText(
  input: string,
  detail: VoiceSpeakDetail = "balanced",
): SpeakableText {
  const withoutInternal = input
    .replace(INTERNAL_TAG_REGION, " ")
    .replace(TOOL_BRACKET, " ");

  const kept: string[] = [];
  let inFence = false;
  let inDiff = false;
  let inTraceback = false;

  for (const raw of withoutInternal.split(/\r?\n/u)) {
    const trimmed = raw.trim();

    if (FENCE.test(trimmed)) {
      inFence = !inFence;
      inDiff = false;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (INTERNAL_PREFIX.test(trimmed)) {
      continue;
    }

    if (DIFF_MARKER.test(trimmed)) {
      inDiff = true;
      continue;
    }
    if (inDiff) {
      if (HUNK_LINE.test(raw)) {
        continue;
      }
      inDiff = false;
    }

    if (/^(?: {4,}|\t)/u.test(raw)) {
      continue;
    }
    if (TRACEBACK.test(trimmed) || STACK_FRAME.test(trimmed)) {
      inTraceback = true;
      continue;
    }
    if (inTraceback) {
      if (TRACE_FRAME.test(raw) || TRACE_EXCEPTION.test(trimmed)) {
        continue;
      }
      inTraceback = false;
    }
    if (JSON_LINE.test(trimmed) || TABLE_SEPARATOR.test(trimmed)) {
      continue;
    }
    if (
      KEY_VALUE_DUMP.test(trimmed) &&
      trimmed.length > 120 &&
      !/[.!?]/u.test(trimmed)
    ) {
      continue;
    }

    const cleaned = cleanInline(trimmed);
    if (cleaned.length === 0 || mostlyPunctuation(cleaned)) {
      continue;
    }
    kept.push(cleaned);
  }

  const joined = collapseWhitespace(kept.join(" "));
  return truncateSpeakable(
    collapseWhitespace(
      joined.replace(HTML_TAG, " ").replace(INLINE_INTERNAL, " "),
    ),
    speakDetailCap(detail),
  );
}
