/** Makes the next call of a named fake operation throw, to exercise rollback paths. */
export class FailureInjection {
  readonly #pending = new Map<string, Error>();

  failNext(operation: string, error: Error = new Error(`injected failure in ${operation}`)): void {
    this.#pending.set(operation, error);
  }

  check(operation: string): void {
    const error = this.#pending.get(operation);
    if (error === undefined) return;
    this.#pending.delete(operation);
    throw error;
  }
}
