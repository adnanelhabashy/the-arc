const MIN_WORDS_TO_GUARD = 6;
const MIN_CONSECUTIVE_REPEATS = 4;
const MIN_REPETITION_COVERAGE = 0.6;
const GLUED_RUN_MIN_REPEATS = 3;
const GLUED_RUN_MAX_UNIT_LENGTH = 4;

const WORD_PATTERN = /[\p{L}\p{M}]+/gu;

function expandGluedRun(word: string): string[] {
  const length = word.length;
  const maxUnitLength = Math.min(
    GLUED_RUN_MAX_UNIT_LENGTH,
    Math.floor(length / GLUED_RUN_MIN_REPEATS),
  );
  for (let unitLength = 1; unitLength <= maxUnitLength; unitLength += 1) {
    if (length % unitLength !== 0) continue;
    const repeats = length / unitLength;
    if (repeats < GLUED_RUN_MIN_REPEATS) continue;
    const unit = word.slice(0, unitLength);
    let matches = true;
    for (let offset = unitLength; offset < length; offset += unitLength) {
      if (word.slice(offset, offset + unitLength) !== unit) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return Array.from({ length: repeats }, () => unit);
    }
  }
  return [word];
}

function maximalRepeatedCoverage(
  words: string[],
  minRepeats: number,
): number {
  const total = words.length;
  const maxUnitLength = Math.floor(total / minRepeats);
  let maxCovered = 0;

  for (let unitLength = 1; unitLength <= maxUnitLength; unitLength += 1) {
    for (let start = 0; start + unitLength <= total; start += 1) {
      let repeats = 1;
      let cursor = start + unitLength;
      while (cursor + unitLength <= total) {
        let equal = true;
        for (let index = 0; index < unitLength; index += 1) {
          if (words[start + index] !== words[cursor + index]) {
            equal = false;
            break;
          }
        }
        if (!equal) break;
        repeats += 1;
        cursor += unitLength;
      }
      if (repeats >= minRepeats) {
        const covered = repeats * unitLength;
        if (covered > maxCovered) {
          maxCovered = covered;
        }
      }
    }
  }

  return maxCovered;
}

export function isPathologicalRepetition(text: string): boolean {
  const words = text.toLowerCase().match(WORD_PATTERN) ?? [];
  const expanded = words.flatMap(expandGluedRun);
  if (expanded.length < MIN_WORDS_TO_GUARD) {
    return false;
  }
  const maxCovered = maximalRepeatedCoverage(
    expanded,
    MIN_CONSECUTIVE_REPEATS,
  );
  return maxCovered >= expanded.length * MIN_REPETITION_COVERAGE;
}
