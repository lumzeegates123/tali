import type { PublicConfig } from "@tali/config/public";
import { Text, View } from "react-native";
import { isLocalSignInAvailable } from "../auth/local-sign-in";
import { useSession, useSessionStore } from "../auth/session-context";
import type { SessionSnapshot } from "../auth/session-store";
import { BusinessOverviewScreen, BusinessPickerScreen } from "./business-screens";
import { LocalSignInScreen, RegistrationScreen } from "./sign-in-screens";
import { Button, FailureNotice, Heading, Loading, styles } from "./ui";

/**
 * Build 1 Android onboarding: local sign-in, registration, business picker
 * or creation, and the business overview. The session is in memory only (an
 * app restart starts signed out); the API authorizes everything.
 */
export function OnboardingApp({ config }: { readonly config: PublicConfig }) {
  if (!isLocalSignInAvailable(config)) {
    return (
      <View style={styles.screen}>
        <Heading>Sign in</Heading>
        <Text testID="sign-in-unavailable">Sign-in is not available in this environment yet.</Text>
      </View>
    );
  }
  return <OnboardingScreens />;
}

function OnboardingScreens() {
  const session = useSession();
  return (
    <View>
      {session.phase === "signedOut" ? null : <SessionBar session={session} />}
      <Screen session={session} />
    </View>
  );
}

function SessionBar({ session }: { readonly session: SessionSnapshot }) {
  const store = useSessionStore();
  return (
    <View style={[styles.row, { justifyContent: "space-between", paddingVertical: 8 }]}>
      <Text>
        {session.user === undefined ? "Local development session" : `Signed in as ${session.user.displayName}`}
      </Text>
      <Button
        label="Sign out"
        onPress={() => {
          store.signOut();
        }}
        secondary
      />
    </View>
  );
}

function Screen({ session }: { readonly session: SessionSnapshot }) {
  const store = useSessionStore();
  switch (session.phase) {
    case "signedOut":
      return <LocalSignInScreen />;
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
          <BusinessPickerScreen />
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
