"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { MoveFocusContext } from "../onboarding/screen-heading";
import type { CatalogSnapshot, CatalogStore } from "./catalog-store";

const CatalogContext = createContext<CatalogStore | undefined>(undefined);

/** Provides the selected business's catalog store; it carries state and methods only, never credentials. */
export function CatalogProvider({ store, children }: { readonly store: CatalogStore; readonly children: ReactNode }) {
  return <CatalogContext.Provider value={store}>{children}</CatalogContext.Provider>;
}

export function useCatalogStore(): CatalogStore {
  const store = useContext(CatalogContext);
  if (store === undefined) throw new Error("useCatalogStore must be used inside CatalogProvider");
  return store;
}

export function useCatalog(): CatalogSnapshot {
  const store = useCatalogStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** A catalog view heading (h3) that takes focus when its view opens, like the onboarding screen headings. */
export function ViewHeading({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  const moveFocus = useContext(MoveFocusContext);
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (moveFocus) ref.current?.focus();
  }, [moveFocus]);
  return (
    <h3 id={id} ref={ref} tabIndex={-1}>
      {children}
    </h3>
  );
}
