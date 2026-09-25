export type VoiceModeState =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "transcribing" }
  | { kind: "thinking" }
  | { kind: "speaking"; messageId: string }
  | { kind: "interrupted" }
  | { kind: "error"; message: string };

export type VoiceModeStateKind = VoiceModeState["kind"];

export interface VoiceModeEffects {
  startCapture(): void;
  cancelCapture(): void;
  transcribe(): Promise<string | null>;
  send(text: string): Promise<void>;
  awaitAssistantReply(): Promise<{ messageId: string; text: string } | null>;
  speak(messageId: string, text: string): Promise<void>;
  stopSpeaking(): void;
  startBargeInDetection(onBargeIn: () => void): void;
  stopBargeInDetection(): void;
}

type Listener = (state: VoiceModeState) => void;

const AUTO_LOOP_AFTER_SPEAK = true;

function defaultDefer(fn: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(fn);
  } else {
    setTimeout(fn, 0);
  }
}

export class VoiceModeSession {
  private state: VoiceModeState = { kind: "idle" };
  private generation = 0;
  private readonly listeners = new Set<Listener>();
  private readonly defer: (fn: () => void) => void;

  constructor(
    private readonly effects: VoiceModeEffects,
    options: { defer?: (fn: () => void) => void } = {},
  ) {
    this.defer = options.defer ?? defaultDefer;
  }

  getState(): VoiceModeState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(next: VoiceModeState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  start(): void {
    if (this.state.kind !== "idle" && this.state.kind !== "error") return;
    const generation = ++this.generation;
    this.setState({ kind: "listening" });
    try {
      this.effects.startCapture();
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.fail(error);
    }
  }

  utteranceEnded(): void {
    if (this.state.kind !== "listening") return;
    const generation = this.generation;
    this.setState({ kind: "transcribing" });
    void this.transcribeAndSend(generation);
  }

  private async transcribeAndSend(generation: number): Promise<void> {
    let text: string | null;
    try {
      text = await this.effects.transcribe();
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.fail(error);
      return;
    }
    if (!this.isCurrent(generation)) return;
    if (text === null || text.trim().length === 0) {
      this.setState({ kind: "listening" });
      this.effects.startCapture();
      return;
    }
    this.setState({ kind: "thinking" });
    try {
      await this.effects.send(text);
      const reply = await this.effects.awaitAssistantReply();
      if (!this.isCurrent(generation)) return;
      if (reply === null || reply.text.trim().length === 0) {
        this.setState({ kind: "listening" });
        this.effects.startCapture();
        return;
      }
      this.speakReply(generation, reply.messageId, reply.text);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.fail(error);
    }
  }

  private speakReply(
    generation: number,
    messageId: string,
    text: string,
  ): void {
    this.setState({ kind: "speaking", messageId });
    this.effects.startBargeInDetection(() => {
      this.handleBargeIn();
    });
    void this.effects.speak(messageId, text).then(
      () => {
        if (!this.isCurrent(generation)) return;
        if (this.state.kind !== "speaking") return;
        this.effects.stopBargeInDetection();
        if (AUTO_LOOP_AFTER_SPEAK) {
          this.setState({ kind: "listening" });
          this.effects.startCapture();
        } else {
          this.setState({ kind: "idle" });
        }
      },
      (error: unknown) => {
        if (!this.isCurrent(generation)) return;
        this.effects.stopBargeInDetection();
        this.fail(error);
      },
    );
  }

  handleBargeIn(): void {
    if (this.state.kind !== "speaking") return;
    this.effects.stopSpeaking();
    this.effects.stopBargeInDetection();
    const generation = ++this.generation;
    this.setState({ kind: "interrupted" });
    // Let the contraction render one frame before capture restarts; the
    // animator and state text both need the Interrupted state to be visible.
    const beginListening = (): void => {
      if (!this.isCurrent(generation)) return;
      this.setState({ kind: "listening" });
      try {
        this.effects.startCapture();
      } catch (error) {
        if (!this.isCurrent(generation)) return;
        this.fail(error);
      }
    };
    this.defer(beginListening);
  }

  cancel(): void {
    this.generation += 1;
    this.effects.stopBargeInDetection();
    this.effects.stopSpeaking();
    this.effects.cancelCapture();
    this.setState({ kind: "idle" });
  }

  acknowledgeError(): void {
    if (this.state.kind !== "error") return;
    this.setState({ kind: "idle" });
  }

  /** Report an asynchronous capture failure the machine cannot observe. */
  externalError(message: string): void {
    if (this.state.kind === "idle" || this.state.kind === "error") return;
    this.fail(new Error(message));
  }

  private fail(error: unknown): void {
    this.effects.stopBargeInDetection();
    this.effects.stopSpeaking();
    this.effects.cancelCapture();
    this.setState({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
