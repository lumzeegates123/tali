"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useSyncExternalStore } from "react";
import type { SessionSnapshot, SessionStore } from "./session-store";

const SessionContext = createContext<SessionStore | undefined>(undefined);

/** Provides one in-memory session to the onboarding screens. */
export function SessionProvider({ store, children }: { readonly store: SessionStore; readonly children: ReactNode }) {
  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>;
}

export function useSessionStore(): SessionStore {
  const store = useContext(SessionContext);
  if (store === undefined) throw new Error("useSessionStore must be used inside SessionProvider");
  return store;
}

export function useSession(): SessionSnapshot {
  const store = useSessionStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
