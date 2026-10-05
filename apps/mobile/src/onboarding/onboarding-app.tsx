import type { MobilePublicConfig } from "@tali/config/public";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { CognitoAuth } from "../auth/cognito-auth";
import { lazyCognitoAuth } from "../auth/cognito-auth";
import { isCognitoSignInAvailable, isLocalSignInAvailable } from "../auth/local-sign-in";
import { useSession, useSessionStore } from "../auth/session-context";
import type { SessionSnapshot } from "../auth/session-store";
import { BusinessOverviewScreen, BusinessPickerScreen } from "./business-screens";
import { CognitoSignIn } from "./cognito-sign-in";
import { LocalSignInScreen, RegistrationScreen } from "./sign-in-screens";
import { AcceptInvitationPanel } from "./team-screens";
import { Button, FailureNotice, Heading, Loading, styles } from "./ui";

/** How a signed-out user signs in on this build. */
type SignInMethod = { readonly kind: "local" } | { readonly kind: "cognito"; readonly auth: CognitoAuth };

/** The stored Cognito session (ADR-007) at app start: being read, unreachable, or settled. */
type Restoration = "restoring" | "unavailable" | "settled";

function signInMethodFor(config: MobilePublicConfig, cognito: CognitoAuth | undefined): SignInMethod | undefined {
  if (isLocalSignInAvailable(config)) return { kind: "local" };
  if (isCognitoSignInAvailable(config) && config.cognito !== undefined) {
    return { kind: "cognito", auth: cognito ?? lazyCognitoAuth(config.cognito) };
  }
  return undefined;
}

/**
 * Build 1 Android onboarding: sign-in (local development, or Cognito in the
 * app's own UI), registration, business picker or creation, joining a
 * business by invitation, the business overview and this device's
 * registration. A Cognito session is kept in the platform keystore (ADR-007) and
 * restored at start; a local development session is memory only. Device
 * registrations are kept in the keystore. The API authorizes everything.
 */
export function OnboardingApp({
  config,
  cognito,
}: {
  readonly config: MobilePublicConfig;
  /** Tests only: a Cognito implementation to use instead of Amplify. */
  readonly cognito?: CognitoAuth;
}) {
  const [method] = useState(() => signInMethodFor(config, cognito));
  if (method === undefined) {
    return (
      <View style={styles.screen}>
        <Heading>Sign in</Heading>
        <Text testID="sign-in-unavailable">Sign-in is not available in this environment yet.</Text>
      </View>
    );
  }
  return <OnboardingScreens method={method} />;
}

function OnboardingScreens({ method }: { readonly method: SignInMethod }) {
  const session = useSession();
  const store = useSessionStore();
  const [restoration, setRestoration] = useState<Restoration>(method.kind === "cognito" ? "restoring" : "settled");
  const started = useRef(false);

  async function restore(auth: CognitoAuth) {
    setRestoration("restoring");
    const result = await auth.restore().catch(() => ({ status: "unavailable" }) as const);
    if (result.status === "signedIn") {
      setRestoration("settled");
      await store.beginSession(result.session);
      return;
    }
    setRestoration(result.status === "unavailable" ? "unavailable" : "settled");
  }

  useEffect(() => {
    if (method.kind !== "cognito" || started.current) return;
    started.current = true;
    if (store.getSnapshot().phase !== "signedOut") {
      setRestoration("settled");
      return;
    }
    void restore(method.auth);
    // Runs once per mount: restoration happens at app start, not on every render.
  }, []);

  if (session.phase === "signedOut" && method.kind === "cognito" && restoration !== "settled") {
    return restoration === "restoring" ? (
      <View style={styles.screen}>
        <Heading>Sign in</Heading>
        <Loading label="Restoring your session…" />
      </View>
    ) : (
      <View style={styles.screen}>
        <Heading>Sign in</Heading>
        <Text style={styles.alert} accessibilityRole="alert" testID="restore-unavailable">
          Tali could not reach the sign-in service to restore your session. Check your connection and try again.
        </Text>
        <Button label="Try again" onPress={() => void restore(method.auth)} />
        <Button
          label="Sign out"
          onPress={() => {
            void method.auth.forgetStoredSession().finally(() => {
              setRestoration("settled");
            });
          }}
          secondary
        />
      </View>
    );
  }
  return (
    <View>
      {session.phase === "signedOut" ? null : <SessionBar session={session} method={method} />}
      <Screen session={session} method={method} />
    </View>
  );
}

function SessionBar({ session, method }: { readonly session: SessionSnapshot; readonly method: SignInMethod }) {
  const store = useSessionStore();
  return (
    <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap", paddingVertical: 8 }]}>
      <Text>
        {session.user === undefined
          ? method.kind === "local"
            ? "Local development session"
            : "Signed in"
          : `Signed in as ${session.user.displayName}`}
      </Text>
      <Button
        label="Sign out"
        onPress={() => {
          store.signOut();
        }}
        secondary
      />
      {method.kind === "cognito" ? (
        <Button
          label="Sign out on all devices"
          onPress={() => {
            store.signOut({ everywhere: true });
          }}
          secondary
        />
      ) : null}
    </View>
  );
}

function Screen({ session, method }: { readonly session: SessionSnapshot; readonly method: SignInMethod }) {
  const store = useSessionStore();
  switch (session.phase) {
    case "signedOut":
      return method.kind === "local" ? <LocalSignInScreen /> : <CognitoSignIn auth={method.auth} />;
    case "signingIn":
      return (
        <View style={styles.screen}>
          <Heading>Signing in</Heading>
          <Loading label={session.pending === "signIn" ? "Signing in…" : "Checking your account…"} />
        </View>
      );
    case "needsRegistration":
      return <RegistrationScreen />;
    case "loadingBusinesses":
      return (
        <View style={styles.screen}>
          <Heading>Your businesses</Heading>
          <Loading label="Loading your businesses…" />
        </View>
      );
    case "choosingBusiness":
      return (
        <View>
          {session.notice === "businessUnavailable" ? (
            <Text style={styles.notice} accessibilityLiveRegion="polite">
              That business is no longer available to you.
            </Text>
          ) : null}
          {session.notice === "invitationAccepted" ? (
            <Text style={styles.notice} accessibilityLiveRegion="polite">
              Invitation accepted. The business is now in your list.
            </Text>
          ) : null}
          <BusinessPickerScreen />
          <AcceptInvitationPanel />
        </View>
      );
    case "businessSelected":
      return session.selectedBusinessId === undefined ? null : (
        <BusinessOverviewScreen key={session.selectedBusinessId} businessId={session.selectedBusinessId} />
      );
    case "error":
      return (
        <View style={styles.screen}>
          <Heading>
            {session.error?.failure.kind === "api-error" && session.error.failure.code === "USER_DISABLED"
              ? "Account unavailable"
              : "Something went wrong"}
          </Heading>
          {session.error === undefined ? null : (
            <FailureNotice
              failure={session.error.failure}
              onRetry={() => {
                void store.retry();
              }}
            />
          )}
        </View>
      );
  }
}
