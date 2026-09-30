import { readWebConfig } from "../../../lib/config/web-config";
import { OnboardingApp } from "../../../onboarding/onboarding-app";
import { AppShell } from "../../../shell/app-shell";

/**
 * `/invitations/accept#token=...`. The token is in the fragment, so it never
 * reaches this server; the client removes it from the address bar on load and
 * keeps it in memory until the signed-in user accepts.
 */
export default function AcceptInvitationPage() {
  const result = readWebConfig();
  return (
    <AppShell result={result}>{result.ok ? <OnboardingApp config={result.config} invitationLink /> : null}</AppShell>
  );
}
