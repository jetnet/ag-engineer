/**
 * Non-overlapping poller using setTimeout chaining.
 * Features:
 * - No overlapping executions (waits for previous to complete)
 * - Exponential backoff on failure, immediate recovery on success
 * - AbortController support for clean shutdown
 * - Configurable interval
 */
import { logDebug, logWarning } from '../logging/logger';

export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private abortController: AbortController | null = null;
  private failCount = 0;
  private readonly maxBackoff = 120_000; // 2 minutes

  constructor(
    private readonly name: string,
    private readonly fn: (signal: AbortSignal) => Promise<void>,
    private intervalMs: number,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failCount = 0;
    this.abortController = new AbortController();
    logDebug(`Poller [${this.name}] started (interval: ${this.intervalMs}ms)`);
    // Run immediately on start
    this.tick();
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logDebug(`Poller [${this.name}] stopped`);
  }

  setInterval(ms: number): void {
    this.intervalMs = ms;
  }

  /** Trigger an immediate execution (skips waiting). */
  triggerNow(): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.tick();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get consecutiveFailures(): number {
    return this.failCount;
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.abortController) return;

    try {
      await this.fn(this.abortController.signal);
      this.failCount = 0;
    } catch (err) {
      if (this.abortController?.signal.aborted) return;
      this.failCount++;
      logWarning(
        `Poller [${this.name}] error (fail #${this.failCount}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!this.running) return;

    // Calculate next delay: base interval on success, exponential backoff on failure
    const delay =
      this.failCount === 0
        ? this.intervalMs
        : Math.min(this.intervalMs * Math.pow(2, this.failCount), this.maxBackoff);

    this.timer = setTimeout(() => this.tick(), delay);
  }
}
