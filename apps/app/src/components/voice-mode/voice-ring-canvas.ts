export type VoiceRingVisualState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "error";

export interface VoiceRingLevelSource {
  /** Live amplitude 0..1; written by the audio pipeline, read every frame. */
  level: number;
}

interface Ripple {
  radius: number;
  alpha: number;
}

const RIPPLE_SPEED = 0.9;
const RIPPLE_FADE = 0.02;
const INTERRUPT_MS = 240;
const TAU = Math.PI * 2;

export class VoiceRingAnimator {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reducedMotion: boolean;
  private rafId: number | null = null;
  private state: VoiceRingVisualState = "idle";
  private levelSource: VoiceRingLevelSource | null = null;
  private smoothedLevel = 0;
  private previousLevel = 0;
  private readonly ripples: Ripple[] = [];
  private interruptedAt: number | null = null;
  private readonly now: () => number;
  private strokeStyle: string;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: {
      reducedMotion: boolean;
      now?: () => number;
    } = { reducedMotion: false },
  ) {
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("VoiceRingAnimator requires a 2D canvas context");
    }
    this.ctx = ctx;
    this.reducedMotion = options.reducedMotion;
    this.now = options.now ?? (() => performance.now());
    this.strokeStyle =
      getComputedStyle(document.documentElement).getPropertyValue(
        "--color-ring",
      ) || "currentColor";
  }

  refreshTheme(): void {
    this.strokeStyle =
      getComputedStyle(document.documentElement).getPropertyValue(
        "--color-ring",
      ) || "currentColor";
  }

  setState(state: VoiceRingVisualState): void {
    if (this.state === state) return;
    this.state = state;
    if (state === "interrupted") {
      this.interruptedAt = this.now();
    }
  }

  attachLevelSource(source: VoiceRingLevelSource | null): void {
    this.levelSource = source;
  }

  start(): void {
    if (this.rafId !== null) return;
    const frame = (): void => {
      this.draw();
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private readLevel(): number {
    const raw = this.levelSource?.level ?? 0;
    const clamped = Math.min(1, Math.max(0, raw));
    this.smoothedLevel =
      this.smoothedLevel * 0.65 + clamped * 0.35;
    if (
      this.smoothedLevel > 0.45 &&
      this.previousLevel <= 0.45 &&
      (this.state === "listening" || this.state === "speaking") &&
      !this.reducedMotion
    ) {
      this.ripples.push({ radius: 0, alpha: 0.55 });
    }
    this.previousLevel = this.smoothedLevel;
    return this.smoothedLevel;
  }

  private draw(): void {
    const { canvas, ctx } = this;
    const width = canvas.width;
    const height = canvas.height;
    const cx = width / 2;
    const cy = height / 2;
    const base = Math.min(width, height) * 0.28;
    ctx.clearRect(0, 0, width, height);

    const level = this.reducedMotion ? 0 : this.readLevel();
    let radius = base;
    const t = this.now() / 1000;
    ctx.strokeStyle = this.strokeStyle;
    ctx.shadowColor = this.strokeStyle;
    ctx.shadowBlur = 12 + level * 22;

    if (this.state === "interrupted" && this.interruptedAt !== null) {
      const k = Math.min(1, (this.now() - this.interruptedAt) / INTERRUPT_MS);
      radius *= 1 - 0.4 * (1 - k) * (1 - k);
    }

    ctx.lineWidth = 2;

    if (this.state === "thinking") {
      this.drawThinking(cx, cy, radius, t);
      return;
    }

    if (this.state === "idle" || this.state === "error") {
      ctx.globalAlpha = this.state === "error" ? 0.9 : 0.45;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    if (this.reducedMotion) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.stroke();
      return;
    }

    if (this.state === "transcribing") {
      const pulse = 1 + Math.sin(t * 6) * 0.05;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * pulse, 0, TAU);
      ctx.stroke();
      return;
    }

    // listening / speaking: real-amplitude waveform ring.
    const points = 96;
    ctx.beginPath();
    for (let i = 0; i <= points; i += 1) {
      const angle = (i / points) * TAU;
      const wave =
        Math.sin(angle * 7 + t * 5) * level * radius * 0.35 +
        Math.sin(angle * 3 - t * 3) * level * radius * 0.15;
      const r = radius + wave;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.stroke();

    // inner core brightens with level
    ctx.globalAlpha = 0.25 + level * 0.6;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * (0.28 + level * 0.12), 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // outward propagation ripples
    for (let i = this.ripples.length - 1; i >= 0; i -= 1) {
      const ripple = this.ripples[i];
      ripple.radius += RIPPLE_SPEED * (1 + level);
      ripple.alpha -= RIPPLE_FADE;
      if (ripple.alpha <= 0) {
        this.ripples.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = ripple.alpha;
      ctx.beginPath();
      ctx.arc(cx, cy, radius + ripple.radius, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawThinking(
    cx: number,
    cy: number,
    radius: number,
    t: number,
  ): void {
    const { ctx } = this;
    // Calm deliberate orbital motion: three slow segments, no audio input.
    for (let i = 0; i < 3; i += 1) {
      const r = radius * (0.75 + i * 0.28);
      const speed = 0.35 - i * 0.09;
      const offset = t * speed + (i * TAU) / 3;
      const span = TAU * 0.42;
      ctx.globalAlpha = 0.5 - i * 0.12;
      ctx.beginPath();
      ctx.arc(cx, cy, r, offset, offset + span);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.3 + Math.sin(t * 1.6) * 0.12;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.22, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
