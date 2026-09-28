import { AsyncLocalStorage } from "node:async_hooks";
import type { IsolationLevel, TransactionScope, UnitOfWork, UnitOfWorkOptions } from "@tali/application";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { closeScope, openScope } from "./transaction-scope.js";

const PRISMA_ISOLATION: Record<IsolationLevel, Prisma.TransactionIsolationLevel> = {
  "read-committed": Prisma.TransactionIsolationLevel.ReadCommitted,
  "repeatable-read": Prisma.TransactionIsolationLevel.RepeatableRead,
  serializable: Prisma.TransactionIsolationLevel.Serializable,
};

const STRENGTH: Record<IsolationLevel, number> = { "read-committed": 0, "repeatable-read": 1, serializable: 2 };

export interface TransactionTimeouts {
  /** Maximum wait to acquire a connection for the transaction. */
  readonly maxWaitMs: number;
  /** Maximum duration of the interactive transaction before Prisma aborts it. */
  readonly timeoutMs: number;
}

interface ActiveTransaction {
  readonly scope: TransactionScope;
  readonly isolationLevel: IsolationLevel;
}

/**
 * UnitOfWork over Prisma interactive transactions.
 *
 * Nesting: a run() started while another run() on the same unit of work is in
 * progress (in the same async context) joins the outer transaction instead of
 * opening a second connection, so composed use cases commit or roll back
 * together. A nested run may not request a stricter isolation level than the
 * transaction it joins; that is a programming error and throws.
 */
export class PrismaUnitOfWork implements UnitOfWork {
  readonly #client: PrismaClient;
  readonly #timeouts: TransactionTimeouts;
  readonly #active = new AsyncLocalStorage<ActiveTransaction>();

  constructor(client: PrismaClient, timeouts: TransactionTimeouts = { maxWaitMs: 5_000, timeoutMs: 15_000 }) {
    this.#client = client;
    this.#timeouts = timeouts;
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
    return this.#client.$transaction(
      async (tx) => {
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
