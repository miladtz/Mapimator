export type PreviewClockListener = () => void;

export interface AnimationScheduler {
  now(): number;
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

const browserScheduler: AnimationScheduler = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

/**
 * A single elapsed-time Preview clock. It intentionally lives outside React:
 * only the map and playhead subscribe at display rate, rather than re-rendering
 * the complete editor shell on every animation frame.
 */
export class PreviewClock {
  private time = 0;
  private duration = 0;
  private startedAt = 0;
  private frame: number | null = null;
  private listeners = new Set<PreviewClockListener>();
  private completion: (() => void) | null = null;

  constructor(private readonly scheduler: AnimationScheduler = browserScheduler) {}

  getSnapshot = () => this.time;

  subscribe = (listener: PreviewClockListener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  play(duration: number, onComplete: () => void) {
    this.cancelFrame();
    this.duration = Math.max(0, duration);
    this.completion = onComplete;
    // Preserve one complete display frame at the exact current timestamp
    // before elapsed-time advancement. This makes Preview's first visible
    // frame byte-for-byte equivalent to the source View camera at t=0.
    this.frame = this.scheduler.request(this.beginPlayback);
  }

  pause() {
    this.cancelFrame();
  }

  seek(time: number) {
    const next = Math.max(0, Math.min(this.duration || Number.POSITIVE_INFINITY, time));
    if (next === this.time) return;
    this.time = next;
    this.emit();
  }

  stop() {
    this.cancelFrame();
    this.completion = null;
    this.time = 0;
    this.emit();
  }

  destroy() {
    this.stop();
    this.listeners.clear();
  }

  private tick = (timestamp: number) => {
    const next = Math.max(0, (timestamp - this.startedAt) / 1000);
    if (next >= this.duration) {
      this.time = this.duration;
      this.frame = null;
      this.emit();
      const completion = this.completion;
      this.completion = null;
      completion?.();
      return;
    }
    this.time = next;
    this.emit();
    this.frame = this.scheduler.request(this.tick);
  };

  private beginPlayback = (timestamp: number) => {
    this.startedAt = timestamp - this.time * 1000;
    this.emit();
    this.frame = this.scheduler.request(this.tick);
  };

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  private cancelFrame() {
    if (this.frame !== null) this.scheduler.cancel(this.frame);
    this.frame = null;
  }
}
