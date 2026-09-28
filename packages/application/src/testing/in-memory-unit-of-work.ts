import type { TransactionScope, UnitOfWork, UnitOfWorkOptions } from "../ports/unit-of-work.js";

/**
 * Records commits and rollbacks for tests. It provides no isolation and does
 * not undo in-memory state; database transaction behaviour is proven against
 * PostgreSQL in the database package.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  commits = 0;
  rollbacks = 0;
  readonly runs: UnitOfWorkOptions[] = [];

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    this.runs.push(options);
    const scope = Object.freeze({}) as unknown as TransactionScope;
    try {
      const result = await work(scope);
      this.commits += 1;
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }
}
