/** Makes the next call of a named fake operation throw, to exercise rollback paths. */
export class FailureInjection {
  readonly #pending = new Map<string, Error>();
  readonly #pendingAfter = new Map<string, Error>();

  failNext(operation: string, error: Error = new Error(`injected failure in ${operation}`)): void {
    this.#pending.set(operation, error);
  }

  /** Makes the next call of `operation` throw after its write has been applied, inside the same unit of work. */
  failAfter(operation: string, error: Error = new Error(`injected failure after ${operation}`)): void {
    this.#pendingAfter.set(operation, error);
  }

  check(operation: string): void {
    const error = this.#pending.get(operation);
    if (error === undefined) return;
    this.#pending.delete(operation);
    throw error;
  }

  checkAfter(operation: string): void {
    const error = this.#pendingAfter.get(operation);
    if (error === undefined) return;
    this.#pendingAfter.delete(operation);
    throw error;
  }
}
