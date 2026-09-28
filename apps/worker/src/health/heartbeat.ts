import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type WorkerState = "starting" | "ready" | "stopping" | "stopped";

export interface HeartbeatRecord {
  readonly state: WorkerState;
  readonly pid: number;
  readonly updatedAt: string;
  readonly processed: number;
  readonly failed: number;
}

/**
 * Worker liveness/readiness without an HTTP server: the worker rewrites a small
 * JSON file on every beat. `check-heartbeat` (and later a container
 * healthcheck) reads it and fails when it is stale or not `ready`.
 * With no file configured, the state is still tracked in memory.
 */
export class Heartbeat {
  readonly #file: string | undefined;
  readonly #intervalMs: number;
  #state: WorkerState = "starting";
  #processed = 0;
  #failed = 0;
  #timer: NodeJS.Timeout | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(options: { readonly file: string | undefined; readonly intervalMs: number }) {
    this.#file = options.file;
    this.#intervalMs = options.intervalMs;
  }

  get state(): WorkerState {
    return this.#state;
  }

  get counts(): { readonly processed: number; readonly failed: number } {
    return { processed: this.#processed, failed: this.#failed };
  }

  recordProcessed(): void {
    this.#processed += 1;
  }

  recordFailed(): void {
    this.#failed += 1;
  }

  async transition(state: WorkerState): Promise<void> {
    this.#state = state;
    if (state === "ready" && this.#timer === undefined) {
      this.#timer = setInterval(() => void this.beat(), this.#intervalMs);
      this.#timer.unref();
    }
    if ((state === "stopping" || state === "stopped") && this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.beat();
  }

  beat(): Promise<void> {
    const file = this.#file;
    if (file === undefined) return Promise.resolve();
    const record: HeartbeatRecord = {
      state: this.#state,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      processed: this.#processed,
      failed: this.#failed,
    };
    this.#writing = this.#writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record)}\n`, "utf8");
      await rename(temporary, file);
    });
    return this.#writing;
  }
}
