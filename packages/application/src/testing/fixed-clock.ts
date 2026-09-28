import type { Clock } from "../ports/clock.js";

/** A controllable clock for tests. Time moves only when told to. */
export class FixedClock implements Clock {
  #epochMs: number;

  constructor(start: Date | string) {
    this.#epochMs = FixedClock.toEpochMs(start);
  }

  now(): Date {
    return new Date(this.#epochMs);
  }

  set(instant: Date | string): void {
    this.#epochMs = FixedClock.toEpochMs(instant);
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("FixedClock only moves forward by a finite amount");
    }
    this.#epochMs += milliseconds;
  }

  advanceBySeconds(seconds: number): void {
    this.advanceBy(seconds * 1000);
  }

  private static toEpochMs(instant: Date | string): number {
    const epochMs = new Date(instant).getTime();
    if (Number.isNaN(epochMs)) {
      throw new Error(`invalid instant: ${String(instant)}`);
    }
    return epochMs;
  }
}
