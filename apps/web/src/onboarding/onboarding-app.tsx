"use client";

import type { WebPublicConfig } from "@tali/config/public";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { TaliApiClient } from "../lib/api-client/tali-api-client";
import type { CognitoAuth } from "../lib/auth/cognito-auth";
import { lazyCognitoAuth } from "../lib/auth/cognito-auth";
import { isCognitoSignInAvailable, isLocalSignInAvailable } from "../lib/auth/local-sign-in";
import { SessionProvider, useSession, useSessionStore } from "../lib/auth/session-context";
import type { SessionSnapshot } from "../lib/auth/session-store";
import { SessionStore } from "../lib/auth/session-store";
import { newUuidV7 } from "../lib/ids/uuidv7";
import { takeInvitationToken } from "../lib/invitations/invitation-link";
import { AcceptInvitationPanel } from "./accept-invitation-panel";
import { BusinessOverviewScreen } from "./business-overview";
import { BusinessPicker } from "./business-picker";
import { CognitoSignIn } from "./cognito-sign-in";
import { FailureAlert } from "./failure-alert";
import { LocalSignInForm } from "./local-sign-in-form";
import { RegistrationForm } from "./registration-form";
import { LoadingState, MoveFocusContext, ScreenHeading } from "./screen-heading";

/** How a signed-out user signs in on this build. */
type SignInMethod = { readonly kind: "local" } | { readonly kind: "cognito"; readonly auth: CognitoAuth };

const SignInMethodContext = createContext<SignInMethod>({ kind: "local" });

function createSessionStore(config: WebPublicConfig): SessionStore {
  const api = new TaliApiClient({ baseUrl: config.apiBaseUrl, createCorrelationId: () => crypto.randomUUID() });
  return new SessionStore({ api, newIdempotencyKey: newUuidV7 });
}

function signInMethodFor(config: WebPublicConfig, cognito: CognitoAuth | undefined): SignInMethod | undefined {
  if (isLocalSignInAvailable(config)) return { kind: "local" };
  if (isCognitoSignInAvailable(config) && config.cognito !== undefined) {
    return { kind: "cognito", auth: cognito ?? lazyCognitoAuth(config.cognito) };
  }
  return undefined;
}

/**
 * Build 1 onboarding: sign-in (local development, or Cognito in the app's
 * own UI), registration, business picker or creation, the business overview,
 * and accepting an invitation link. All state is in memory (a reload starts
 * signed out); the API authorizes everything.
 */
export function OnboardingApp({
  config,
  invitationLink = false,
  cognito,
}: {
  readonly config: WebPublicConfig;
  /** Rendered by the invitation page: the URL fragment may carry an invitation token. */
  readonly invitationLink?: boolean;
  /** Tests only: a Cognito implementation to use instead of Amplify. */
  readonly cognito?: CognitoAuth;
}) {
  const [store] = useState(() => createSessionStore(config));
  const [method] = useState(() => signInMethodFor(config, cognito));
  const [linkIncomplete, setLinkIncomplete] = useState(false);
  const linkRead = useRef(false);
  useEffect(() => {
    if (!invitationLink || linkRead.current) return;
    linkRead.current = true;
    const token = takeInvitationToken(window.location, window.history);
    if (token === undefined) setLinkIncomplete(true);
    else store.holdInvitation(token);
  }, [invitationLink, store]);
  const incompleteNotice = linkIncomplete ? (
    <p role="status" className="notice" data-testid="invitation-link-incomplete">
      This invitation link is incomplete. Ask for the full link, or a new invitation.
    </p>
  ) : null;
  if (method === undefined) {
    return (
      <section aria-labelledby="sign-in-heading" className="onboarding">
        <h2 id="sign-in-heading">Sign in</h2>
        <p data-testid="sign-in-unavailable">Sign-in is not available in this environment yet.</p>
      </section>
    );
  }
  return (
    <SignInMethodContext.Provider value={method}>
      <SessionProvider store={store}>
        {incompleteNotice}
        <OnboardingScreens />
      </SessionProvider>
    </SignInMethodContext.Provider>
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
      {session.hasPendingInvitation && (session.phase === "signedOut" || session.phase === "needsRegistration") ? (
        <p role="status" className="notice" data-testid="invitation-waiting">
          You have been invited to a business. Sign in and set up your profile to accept the invitation.
        </p>
      ) : null}
      {session.phase === "choosingBusiness" || session.phase === "businessSelected" ? <AcceptInvitationPanel /> : null}
      <Screen session={session} />
    </MoveFocusContext.Provider>
  );
}

function SessionBar({ session }: { readonly session: SessionSnapshot }) {
  const store = useSessionStore();
  const method = useContext(SignInMethodContext);
  const anonymous = method.kind === "local" ? "Local development session" : "Signed in";
  return (
    <nav aria-label="Session" className="session-bar">
      <p>{session.user === undefined ? anonymous : `Signed in as ${session.user.displayName}`}</p>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          store.signOut();
        }}
      >
        Sign out
      </button>
      {method.kind === "cognito" ? (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            store.signOut({ everywhere: true });
          }}
        >
          Sign out on all devices
        </button>
      ) : null}
    </nav>
  );
}

function Screen({ session }: { readonly session: SessionSnapshot }) {
  const store = useSessionStore();
  const method = useContext(SignInMethodContext);
  switch (session.phase) {
    case "signedOut":
      return method.kind === "local" ? <LocalSignInForm /> : <CognitoSignIn auth={method.auth} />;
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
          {session.notice === "invitationAccepted" ? (
            <p role="status" className="notice">
              Invitation accepted. The business is now in your list.
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
