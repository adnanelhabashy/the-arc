const DEFAULT_MAX_CHUNK_LENGTH = 600;

const SENTENCE_PATTERN = /[^.!?\n]*(?:[.!?]+|\n+)/g;
const FENCE_LINE_PATTERN = /^(?:```|~~~)/u;

function isFenceLine(line: string): boolean {
  return FENCE_LINE_PATTERN.test(line.trimStart());
}

function fenceAwareBlocks(text: string): string[] {
  const blocks: string[] = [];
  let textLines: string[] = [];
  let fenceLines: string[] = [];
  let inFence = false;

  const flushText = () => {
    if (textLines.length > 0) {
      blocks.push(textLines.join("\n"));
      textLines = [];
    }
  };
  const flushFence = () => {
    if (fenceLines.length > 0) {
      blocks.push(fenceLines.join("\n"));
      fenceLines = [];
    }
  };

  for (const line of text.split("\n")) {
    if (isFenceLine(line)) {
      if (inFence) {
        fenceLines.push(line);
        inFence = false;
        flushFence();
        continue;
      }
      flushText();
      fenceLines.push(line);
      inFence = true;
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }
    textLines.push(line);
  }

  flushText();
  flushFence();
  return blocks;
}

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  SENTENCE_PATTERN.lastIndex = 0;
  while ((match = SENTENCE_PATTERN.exec(text)) !== null) {
    const sentence = match[0]
      .replace(/[ \t]+/gu, " ")
      .replace(/\n+$/u, "")
      .trim();
    if (sentence.length > 0) {
      sentences.push(sentence);
    }
    cursor = SENTENCE_PATTERN.lastIndex;
  }
  const remainder = text.slice(cursor).replace(/[ \t]+/gu, " ").trim();
  if (remainder.length > 0) {
    sentences.push(remainder);
  }
  return sentences;
}

export function chunkSpeechText(
  text: string,
  maxChunkLength: number = DEFAULT_MAX_CHUNK_LENGTH,
): string[] {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const atoms: string[] = [];
  for (const block of fenceAwareBlocks(normalized)) {
    if (isFenceLine(block)) {
      atoms.push(block);
      continue;
    }
    atoms.push(...splitSentences(block));
  }

  const chunks: string[] = [];
  let buffer = "";

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }
    buffer = "";
  };

  const appendWords = (atom: string) => {
    for (const word of atom.split(/\s+/u)) {
      if (word.length === 0) {
        continue;
      }
      if (buffer.length === 0) {
        buffer = word;
        continue;
      }
      if (buffer.length + 1 + word.length <= maxChunkLength) {
        buffer = `${buffer} ${word}`;
      } else {
        flush();
        buffer = word;
      }
    }
  };

  for (const atom of atoms) {
    if (isFenceLine(atom)) {
      flush();
      if (atom.length <= maxChunkLength) {
        buffer = atom;
      } else {
        chunks.push(atom);
      }
      continue;
    }
    if (atom.length > maxChunkLength) {
      flush();
      appendWords(atom);
      continue;
    }
    const candidate = buffer.length === 0 ? atom : `${buffer}\n${atom}`;
    if (candidate.length <= maxChunkLength) {
      buffer = candidate;
    } else {
      flush();
      buffer = atom;
    }
  }

  flush();
  return chunks;
}
