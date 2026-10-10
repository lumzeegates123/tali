"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useSyncExternalStore } from "react";
import { describeFailure } from "../lib/api-client/failure-messages";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import type { InventoryAffordances } from "./affordances";
import type { InventorySnapshot, InventoryStore } from "./inventory-store";

const InventoryContext = createContext<InventoryStore | undefined>(undefined);
const AffordancesContext = createContext<InventoryAffordances | undefined>(undefined);

/** Provides the selected business's inventory store; it carries state and methods only, never credentials. */
export function InventoryProvider({
  store,
  allowed,
  children,
}: {
  readonly store: InventoryStore;
  readonly allowed: InventoryAffordances;
  readonly children: ReactNode;
}) {
  return (
    <InventoryContext.Provider value={store}>
      <AffordancesContext.Provider value={allowed}>{children}</AffordancesContext.Provider>
    </InventoryContext.Provider>
  );
}

export function useInventoryStore(): InventoryStore {
  const store = useContext(InventoryContext);
  if (store === undefined) throw new Error("useInventoryStore must be used inside InventoryProvider");
  return store;
}

export function useInventory(): InventorySnapshot {
  const store = useInventoryStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useAllowed(): InventoryAffordances {
  const allowed = useContext(AffordancesContext);
  if (allowed === undefined) throw new Error("useAllowed must be used inside InventoryProvider");
  return allowed;
}

/** Plain-language failure text; inventory screens may give CONFLICT and VERSION_CONFLICT their own wording. */
export function failureText(
  failure: ApiFailure,
  wording: { readonly conflict?: string; readonly versionConflict?: string } = {},
): string {
  if (failure.kind === "api-error") {
    if (failure.code === "CONFLICT" && wording.conflict !== undefined) return wording.conflict;
    if (failure.code === "VERSION_CONFLICT" && wording.versionConflict !== undefined) return wording.versionConflict;
  }
  return describeFailure(failure, { notFoundScope: "resource" }).text;
}

export function InventoryFailure({
  failure,
  conflict,
  versionConflict,
  onRetry,
  retryLabel = "Try again",
}: {
  readonly failure: ApiFailure;
  readonly conflict?: string;
  readonly versionConflict?: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}) {
  const retryable = describeFailure(failure, { notFoundScope: "resource" }).retryable;
  return (
    <div role="alert" className="alert">
      <p>
        {failureText(failure, {
          ...(conflict === undefined ? {} : { conflict }),
          ...(versionConflict === undefined ? {} : { versionConflict }),
        })}
      </p>
      {retryable && onRetry !== undefined ? (
        <button type="button" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export function Notice({ children }: { readonly children: ReactNode }) {
  return (
    <p role="status" className="notice">
      {children}
    </p>
  );
}
