import type { TransactionScope, UnitOfWork, UnitOfWorkOptions } from "../ports/unit-of-work.js";

/** An in-memory fake whose state a UnitOfWork rolls back. `captureState` returns the function that restores it. */
export interface RollbackParticipant {
  captureState(): () => void;
}

/**
 * Records commits and rollbacks for tests. Enlisted participants have their
 * state captured when a run starts and restored if it fails, so tests can
 * show that a failed use case leaves no partial effect in the fakes. It
 * provides no isolation between concurrent runs; database transaction
 * behaviour is proven against PostgreSQL in the database package.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  commits = 0;
  rollbacks = 0;
  readonly runs: UnitOfWorkOptions[] = [];
  readonly #participants: RollbackParticipant[] = [];
  readonly #active = new Set<TransactionScope>();

  enlist(...participants: RollbackParticipant[]): this {
    this.#participants.push(...participants);
    return this;
  }

  /** Throws unless `scope` belongs to a run that has not finished. */
  assertActive(scope: TransactionScope): void {
    if (!this.#active.has(scope)) {
      throw new Error("used a transaction scope outside its unit of work");
    }
  }

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    this.runs.push(options);
    const restores = this.#participants.map((participant) => participant.captureState());
    const scope = Object.freeze({}) as unknown as TransactionScope;
    this.#active.add(scope);
    try {
      const result = await work(scope);
      this.commits += 1;
      return result;
    } catch (error) {
      for (const restore of restores.reverse()) restore();
      this.rollbacks += 1;
      throw error;
    } finally {
      this.#active.delete(scope);
    }
  }
}
