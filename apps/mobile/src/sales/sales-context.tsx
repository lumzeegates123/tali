import type { ReactNode } from "react";
import { createContext, useContext, useSyncExternalStore } from "react";
import type { SalesAffordances } from "./affordances";
import type { SalesSnapshot, SalesStore } from "./sales-store";

const SalesContext = createContext<SalesStore | undefined>(undefined);
const AffordancesContext = createContext<SalesAffordances | undefined>(undefined);

/** Provides the selected business's sales store; it carries state and methods only, never credentials. */
export function SalesProvider({
  store,
  allowed,
  children,
}: {
  readonly store: SalesStore;
  readonly allowed: SalesAffordances;
  readonly children: ReactNode;
}) {
  return (
    <SalesContext.Provider value={store}>
      <AffordancesContext.Provider value={allowed}>{children}</AffordancesContext.Provider>
    </SalesContext.Provider>
  );
}

export function useSalesStore(): SalesStore {
  const store = useContext(SalesContext);
  if (store === undefined) throw new Error("useSalesStore must be used inside SalesProvider");
  return store;
}

export function useSales(): SalesSnapshot {
  const store = useSalesStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useSalesAllowed(): SalesAffordances {
  const allowed = useContext(AffordancesContext);
  if (allowed === undefined) throw new Error("useSalesAllowed must be used inside SalesProvider");
  return allowed;
}
