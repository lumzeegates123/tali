import type { PublicConfig } from "@tali/config/public";
import { randomUUID } from "expo-crypto";
import type { ReactNode } from "react";
import { createContext, useContext, useState, useSyncExternalStore } from "react";
import { TaliApiClient } from "../api/tali-api-client";
import { newUuidV7 } from "../ids/uuidv7";
import type { SessionSnapshot } from "./session-store";
import { SessionStore } from "./session-store";

const SessionContext = createContext<SessionStore | undefined>(undefined);

export function createSessionStore(config: PublicConfig): SessionStore {
  const api = new TaliApiClient({ baseUrl: config.apiBaseUrl, createCorrelationId: randomUUID });
  return new SessionStore({ api, newIdempotencyKey: newUuidV7 });
}

/** Provides one in-memory session to the onboarding screens. */
export function SessionProvider({ store, children }: { readonly store: SessionStore; readonly children: ReactNode }) {
  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>;
}

/**
 * Holds the app's single session for as long as the JavaScript runtime lives
 * (the root layout), so moving between screens keeps it and an app restart
 * loses it. Without valid public configuration there is no session.
 */
export function SessionRoot({
  config,
  children,
}: {
  readonly config: PublicConfig | undefined;
  readonly children: ReactNode;
}) {
  const [store] = useState(() => (config === undefined ? undefined : createSessionStore(config)));
  if (store === undefined) return children;
  return <SessionProvider store={store}>{children}</SessionProvider>;
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
