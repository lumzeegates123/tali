import type { Clock } from "@tali/application";

/**
 * A fixed-window attempt counter held in one process's memory (ADR-005
 * section 18). It is a local safeguard only: it is not shared between
 * processes or tasks and is never relied on as a global limit.
 *
 * Memory is bounded: at most `maxKeys` windows are tracked. Expired windows
 * are pruned first; if the table is still full, a new key is refused rather
 * than evicting a live window (which would reset someone's count).
 */
export class FixedWindowRateLimiter {
  readonly #clock: Clock;
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #windows = new Map<string, { startedAt: number; count: number }>();

  constructor(options: {
    readonly clock: Clock;
    readonly limit: number;
    readonly windowMs: number;
    readonly maxKeys: number;
  }) {
    for (const [name, value] of Object.entries({
      limit: options.limit,
      windowMs: options.windowMs,
      maxKeys: options.maxKeys,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    }
    this.#clock = options.clock;
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys;
  }

  /** Records an attempt for the key. Returns false when the attempt is over the limit. */
  tryConsume(key: string): boolean {
    const now = this.#clock.now().getTime();
    const current = this.#windows.get(key);
    if (current !== undefined && now - current.startedAt < this.#windowMs) {
      if (current.count >= this.#limit) return false;
      current.count += 1;
      return true;
    }
    if (current === undefined && this.#windows.size >= this.#maxKeys) {
      this.#prune(now);
      if (this.#windows.size >= this.#maxKeys) return false;
    }
    this.#windows.set(key, { startedAt: now, count: 1 });
    return true;
  }

  /** The number of tracked windows (for tests). */
  get size(): number {
    return this.#windows.size;
  }

  #prune(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.startedAt >= this.#windowMs) this.#windows.delete(key);
    }
  }
}
