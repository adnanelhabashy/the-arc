export interface UtteranceEndOptions {
  /** RMS level at or above which counts as speech. */
  speechThreshold?: number;
  /** Silence that must follow speech before the utterance ends. */
  silenceMs?: number;
  /** Minimum speech duration for a real utterance (shorter = ignored blip). */
  minSpeechMs?: number;
  now?: () => number;
}

export class UtteranceEndDetector {
  private readonly speechThreshold: number;
  private readonly silenceMs: number;
  private readonly minSpeechMs: number;
  private readonly now: () => number;

  private speechStartedAt: number | null = null;
  private lastSpeechAt: number | null = null;
  private fired = false;

  constructor(options: UtteranceEndOptions = {}) {
    this.speechThreshold = options.speechThreshold ?? 0.06;
    this.silenceMs = options.silenceMs ?? 1_200;
    this.minSpeechMs = options.minSpeechMs ?? 500;
    this.now = options.now ?? Date.now;
  }

  reset(): void {
    this.speechStartedAt = null;
    this.lastSpeechAt = null;
    this.fired = false;
  }

  /**
   * Feed one RMS sample. Returns true exactly once when the current utterance
   * has ended (enough silence after enough speech).
   */
  update(rms: number): boolean {
    if (this.fired) return false;
    const t = this.now();
    if (rms >= this.speechThreshold) {
      if (this.speechStartedAt === null) {
        this.speechStartedAt = t;
      }
      this.lastSpeechAt = t;
      return false;
    }
    if (this.speechStartedAt === null || this.lastSpeechAt === null) {
      return false;
    }
    const speechMs = this.lastSpeechAt - this.speechStartedAt;
    const silenceFor = t - this.lastSpeechAt;
    if (speechMs < this.minSpeechMs) {
      if (silenceFor >= this.silenceMs) {
        // A blip (cough, tap): discard without ending the utterance.
        this.speechStartedAt = null;
        this.lastSpeechAt = null;
      }
      return false;
    }
    if (silenceFor >= this.silenceMs) {
      this.fired = true;
      return true;
    }
    return false;
  }
}
