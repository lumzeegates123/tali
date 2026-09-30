import { AsyncLocalStorage } from "node:async_hooks";
import { randomInt } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ApplicationError,
  ConcurrentModificationError,
  type IsolationLevel,
  type TransactionScope,
  type UnitOfWork,
  type UnitOfWorkOptions,
} from "@tali/application";
import { isLockNotAvailable, isTransactionConflict, TransactionConflict } from "../errors/postgres-errors.js";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { closeScope, openScope, type TransactionClient } from "./transaction-scope.js";

const PRISMA_ISOLATION: Record<IsolationLevel, Prisma.TransactionIsolationLevel> = {
  "read-committed": Prisma.TransactionIsolationLevel.ReadCommitted,
  "repeatable-read": Prisma.TransactionIsolationLevel.RepeatableRead,
  serializable: Prisma.TransactionIsolationLevel.Serializable,
};

const STRENGTH: Record<IsolationLevel, number> = { "read-committed": 0, "repeatable-read": 1, serializable: 2 };

/** ADR-004 section 13: initial protocol values and their upper bounds. */
export const MAX_LOCK_TIMEOUT_MS = 5_000;
export const MAX_TRANSACTION_ATTEMPTS = 3;

export interface TransactionTimeouts {
  /** Maximum wait to acquire a connection for the transaction. */
  readonly maxWaitMs: number;
  /** Maximum duration of the interactive transaction before Prisma aborts it. */
  readonly timeoutMs: number;
}

export interface UnitOfWorkSettings extends TransactionTimeouts {
  /** PostgreSQL lock_timeout set on every transaction: 1 to 5000 ms (default 5000). */
  readonly lockTimeoutMs?: number;
  /** Attempts in total for serialization failures and deadlocks: 1 to 3 (default 3). */
  readonly maxAttempts?: number;
  /** Overall bound for one run() including retries; no retry starts after it (default 30000 ms). */
  readonly deadlineMs?: number;
  /** Backoff before retry n (1-based) is a uniform jitter in [0, min(maxMs, baseMs * 2^(n-1))]. */
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number };
  /** Test seams: jitter source (inclusive upper bound), sleep and monotonic time. */
  readonly jitter?: (maxMs: number) => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly monotonicNow?: () => number;
}

interface ActiveTransaction {
  readonly scope: TransactionScope;
  readonly isolationLevel: IsolationLevel;
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/**
 * UnitOfWork over Prisma interactive transactions.
 *
 * Nesting: a run() started while another run() on the same unit of work is in
 * progress (in the same async context) joins the outer transaction instead of
 * opening a second connection, so composed use cases commit or roll back
 * together. A nested run may not request a stricter isolation level than the
 * transaction it joins; that is a programming error and throws.
 *
 * Concurrency (ADR-004 section 11), applied by the outermost run only:
 * - every transaction sets a bounded lock_timeout;
 * - a serialization failure or deadlock re-runs the whole callback, up to
 *   maxAttempts in total, with jittered backoff and within the deadline;
 *   callbacks therefore perform database work only (ADR-004 section 9).
 *   After the last attempt the error is ConcurrentModificationError;
 * - a lock timeout is not retried and becomes ConcurrentModificationError,
 *   unless an adapter already mapped it (IDEMPOTENCY_IN_PROGRESS);
 * - ApplicationErrors, domain errors, other database errors and anything
 *   else the callback throws propagate unchanged and are never retried.
 */
export class PrismaUnitOfWork implements UnitOfWork {
  readonly #client: PrismaClient;
  readonly #timeouts: TransactionTimeouts;
  readonly #lockTimeout: string;
  readonly #maxAttempts: number;
  readonly #deadlineMs: number;
  readonly #backoff: { readonly baseMs: number; readonly maxMs: number };
  readonly #jitter: (maxMs: number) => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #active = new AsyncLocalStorage<ActiveTransaction>();

  constructor(client: PrismaClient, settings: UnitOfWorkSettings = { maxWaitMs: 5_000, timeoutMs: 15_000 }) {
    this.#client = client;
    this.#timeouts = { maxWaitMs: settings.maxWaitMs, timeoutMs: settings.timeoutMs };
    const lockTimeoutMs = boundedInteger(
      settings.lockTimeoutMs ?? MAX_LOCK_TIMEOUT_MS,
      "lockTimeoutMs",
      1,
      MAX_LOCK_TIMEOUT_MS,
    );
    this.#lockTimeout = `${lockTimeoutMs}ms`;
    this.#maxAttempts = boundedInteger(
      settings.maxAttempts ?? MAX_TRANSACTION_ATTEMPTS,
      "maxAttempts",
      1,
      MAX_TRANSACTION_ATTEMPTS,
    );
    this.#deadlineMs = boundedInteger(settings.deadlineMs ?? 30_000, "deadlineMs", 1, 600_000);
    this.#backoff = settings.backoff ?? { baseMs: 20, maxMs: 200 };
    boundedInteger(this.#backoff.baseMs, "backoff.baseMs", 0, 10_000);
    boundedInteger(this.#backoff.maxMs, "backoff.maxMs", this.#backoff.baseMs, 10_000);
    this.#jitter = settings.jitter ?? ((maxMs) => randomInt(maxMs + 1));
    this.#sleep = settings.sleep ?? ((ms) => sleep(ms));
    this.#now = settings.monotonicNow ?? (() => performance.now());
  }

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const outer = this.#active.getStore();
    if (outer !== undefined) {
      const requested = options.isolationLevel;
      if (requested !== undefined && STRENGTH[requested] > STRENGTH[outer.isolationLevel]) {
        throw new Error(
          `A nested unit of work cannot raise isolation from ${outer.isolationLevel} to ${requested}; set it on the outermost run()`,
        );
      }
      return work(outer.scope);
    }

    const isolationLevel = options.isolationLevel ?? "read-committed";
    const startedAt = this.#now();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#attempt(work, isolationLevel);
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        if (isTransactionConflict(error)) {
          const conflict = new TransactionConflict({ cause: error });
          const delayMs = this.#jitter(Math.min(this.#backoff.maxMs, this.#backoff.baseMs * 2 ** (attempt - 1)));
          const withinDeadline = this.#now() - startedAt + delayMs < this.#deadlineMs;
          if (attempt >= this.#maxAttempts || !withinDeadline) {
            throw new ConcurrentModificationError(undefined, { cause: conflict });
          }
          await this.#sleep(delayMs);
          continue;
        }
        if (isLockNotAvailable(error)) throw new ConcurrentModificationError(undefined, { cause: error });
        throw error;
      }
    }
  }

  async #attempt<T>(work: (scope: TransactionScope) => Promise<T>, isolationLevel: IsolationLevel): Promise<T> {
    return this.#client.$transaction(
      async (tx: TransactionClient) => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${this.#lockTimeout}, true)`;
        const scope = openScope(tx);
        try {
          return await this.#active.run({ scope, isolationLevel }, () => work(scope));
        } finally {
          closeScope(scope);
        }
      },
      {
        isolationLevel: PRISMA_ISOLATION[isolationLevel],
        maxWait: this.#timeouts.maxWaitMs,
        timeout: this.#timeouts.timeoutMs,
      },
    );
  }
}
