import { AsyncLocalStorage } from "node:async_hooks";
import type { CorrelationId } from "@tali/application";

const store = new AsyncLocalStorage<{ readonly correlationId: CorrelationId }>();

export function currentCorrelationId(): CorrelationId | undefined {
  return store.getStore()?.correlationId;
}

export function runWithCorrelationId<T>(correlationId: CorrelationId, work: () => T): T {
  return store.run({ correlationId }, work);
}
