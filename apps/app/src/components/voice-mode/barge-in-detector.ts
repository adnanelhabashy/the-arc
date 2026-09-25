export interface BargeInTrackerOptions {
  /** Fixed minimum RMS that counts as speech, even over a silent floor. */
  threshold?: number;
  /** Fraction of the observed noise floor that also counts as speech. */
  floorRatio?: number;
  /** Consecutive over-threshold windows required before firing. */
  minWindows?: number;
  /** Ignore detections for this long after arming (residual echo). */
  cooldownMs?: number;
  /** RMS smoothing factor (0..1); higher = smoother, slower. */
  smoothing?: number;
  now?: () => number;
}

export class BargeInTracker {
  private readonly threshold: number;
  private readonly floorRatio: number;
  private readonly minWindows: number;
  private readonly cooldownMs: number;
  private readonly smoothing: number;
  private readonly now: () => number;

  private smoothed = 0;
  private floor: number | null = null;
  private overCount = 0;
  private firedAt: number | null = null;
  private armedAt: number;

  constructor(options: BargeInTrackerOptions = {}) {
    this.threshold = options.threshold ?? 0.05;
    this.floorRatio = options.floorRatio ?? 2.2;
    this.minWindows = options.minWindows ?? 3;
    this.cooldownMs = options.cooldownMs ?? 600;
    this.smoothing = options.smoothing ?? 0.6;
    this.now = options.now ?? Date.now;
    this.armedAt = this.now();
  }

  reset(): void {
    this.smoothed = 0;
    this.floor = null;
    this.overCount = 0;
    this.firedAt = null;
    this.armedAt = this.now();
  }

  private effectiveThreshold(): number {
    if (this.floor === null) return this.threshold;
    return Math.max(this.threshold, this.floor * this.floorRatio);
  }

  /**
   * Feed one RMS window (0..1). Returns true exactly once per utterance when
   * the sustained-energy gate fires.
   */
  update(rms: number): boolean {
    const clamped = Math.min(1, Math.max(0, rms));
    this.smoothed =
      this.smoothed * this.smoothing + clamped * (1 - this.smoothing);
    // Only quiet samples shape the noise floor; speech never raises its own
    // threshold. Quiet is anything under the current effective threshold.
    if (this.smoothed < this.effectiveThreshold()) {
      this.floor = this.smoothed;
    }

    if (this.firedAt !== null) return false;
    if (this.now() - this.armedAt < this.cooldownMs) return false;

    if (this.smoothed >= this.effectiveThreshold()) {
      this.overCount += 1;
    } else {
      this.overCount = 0;
    }
    if (this.overCount >= this.minWindows) {
      this.firedAt = this.now();
      return true;
    }
    return false;
  }
}

export interface BargeInDetectionHandle {
  stop(): void;
}

export interface BargeInDetectorDeps {
  getUserMedia: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
  createAnalyser: (stream: MediaStream) => {
    analyser: AnalyserNode;
    sample(): number;
  };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export async function startBargeInDetection(args: {
  deps: BargeInDetectorDeps;
  tracker?: BargeInTracker;
  onBargeIn: () => void;
}): Promise<BargeInDetectionHandle> {
  const stream = await args.deps.getUserMedia({
    audio: {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
    },
  });
  const { analyser, sample } = args.deps.createAnalyser(stream);
  const tracker = args.tracker ?? new BargeInTracker();
  const setIntervalFn = args.deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = args.deps.clearIntervalFn ?? clearInterval;
  const interval = setIntervalFn(() => {
    if (tracker.update(sample())) {
      args.onBargeIn();
    }
  }, 64);
  return {
    stop: () => {
      clearIntervalFn(interval);
      for (const track of stream.getTracks()) {
        track.stop();
      }
      void analyser;
    },
  };
}
