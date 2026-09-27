declare const transactionBrand: unique symbol;

/**
 * An opaque handle to the active transaction. Repository adapters accept it;
 * application code only passes it through and never inspects it.
 */
export interface TransactionScope {
  readonly [transactionBrand]: true;
}

export type IsolationLevel = "read-committed" | "repeatable-read" | "serializable";

export interface UnitOfWorkOptions {
  readonly isolationLevel?: IsolationLevel;
}

/**
 * Runs work atomically: everything inside commits together or rolls back
 * together when the work throws.
 */
export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
