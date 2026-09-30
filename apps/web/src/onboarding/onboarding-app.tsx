"use client";

import type { PublicConfig } from "@tali/config/public";
import { useEffect, useState } from "react";
import { TaliApiClient } from "../lib/api-client/tali-api-client";
import { isLocalSignInAvailable } from "../lib/auth/local-sign-in";
import { SessionProvider, useSession, useSessionStore } from "../lib/auth/session-context";
import type { SessionSnapshot } from "../lib/auth/session-store";
import { SessionStore } from "../lib/auth/session-store";
import { newUuidV7 } from "../lib/ids/uuidv7";
import { BusinessOverviewScreen } from "./business-overview";
import { BusinessPicker } from "./business-picker";
import { FailureAlert } from "./failure-alert";
import { LocalSignInForm } from "./local-sign-in-form";
import { RegistrationForm } from "./registration-form";
import { LoadingState, MoveFocusContext, ScreenHeading } from "./screen-heading";

function createSessionStore(config: PublicConfig): SessionStore {
  const api = new TaliApiClient({ baseUrl: config.apiBaseUrl, createCorrelationId: () => crypto.randomUUID() });
  return new SessionStore({ api, newIdempotencyKey: newUuidV7 });
}

/**
 * Build 1 onboarding: local sign-in, registration, business picker or
 * creation, and the business overview. All state is in memory (a reload
 * starts signed out); the API authorizes everything.
 */
export function OnboardingApp({ config }: { readonly config: PublicConfig }) {
  const [store] = useState(() => createSessionStore(config));
  if (!isLocalSignInAvailable(config)) {
    return (
      <section aria-labelledby="sign-in-heading" className="onboarding">
        <h2 id="sign-in-heading">Sign in</h2>
        <p data-testid="sign-in-unavailable">Sign-in is not available in this environment yet.</p>
      </section>
    );
  }
  return (
    <SessionProvider store={store}>
      <OnboardingScreens />
    </SessionProvider>
  );
}

function OnboardingScreens() {
  const session = useSession();
  const [firstPhase] = useState(session.phase);
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    if (session.phase !== firstPhase) setMoved(true);
  }, [session.phase, firstPhase]);
  return (
    <MoveFocusContext.Provider value={moved}>
      {session.phase === "signedOut" ? null : <SessionBar session={session} />}
      <Screen session={session} />
    </MoveFocusContext.Provider>
  );
}

function SessionBar({ session }: { readonly session: SessionSnapshot }) {
  const store = useSessionStore();
  return (
    <nav aria-label="Session" className="session-bar">
      <p>{session.user === undefined ? "Local development session" : `Signed in as ${session.user.displayName}`}</p>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          store.signOut();
        }}
      >
        Sign out
      </button>
    </nav>
  );
}

function Screen({ session }: { readonly session: SessionSnapshot }) {
  const store = useSessionStore();
  switch (session.phase) {
    case "signedOut":
      return <LocalSignInForm />;
    case "signingIn":
      return (
        <section aria-labelledby="signing-in-heading" className="onboarding">
          <ScreenHeading id="signing-in-heading">Signing in</ScreenHeading>
          <LoadingState label={session.pending === "signIn" ? "Signing in…" : "Checking your account…"} />
        </section>
      );
    case "needsRegistration":
      return <RegistrationForm />;
    case "loadingBusinesses":
      return (
        <section aria-labelledby="loading-businesses-heading" className="onboarding">
          <ScreenHeading id="loading-businesses-heading">Your businesses</ScreenHeading>
          {session.notice === "businessUnavailable" ? (
            <p role="status">That business is no longer available to you.</p>
          ) : null}
          <LoadingState label="Loading your businesses…" />
        </section>
      );
    case "choosingBusiness":
      return (
        <>
          {session.notice === "businessUnavailable" ? (
            <p role="status" className="notice">
              That business is no longer available to you.
            </p>
          ) : null}
          <BusinessPicker />
        </>
      );
    case "businessSelected":
      return session.selectedBusinessId === undefined ? null : (
        <BusinessOverviewScreen key={session.selectedBusinessId} businessId={session.selectedBusinessId} />
      );
    case "error":
      return (
        <section aria-labelledby="session-error-heading" className="onboarding">
          <ScreenHeading id="session-error-heading">
            {session.error?.failure.kind === "api-error" && session.error.failure.code === "USER_DISABLED"
              ? "Account unavailable"
              : "Something went wrong"}
          </ScreenHeading>
          {session.error === undefined ? null : (
            <FailureAlert
              failure={session.error.failure}
              onRetry={() => {
                void store.retry();
              }}
            />
          )}
        </section>
      );
  }
}
