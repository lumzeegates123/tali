import { readMobileConfig } from "../src/config/mobile-config";
import { ApiHealthPanel } from "../src/health/api-health";
import { OnboardingApp } from "../src/onboarding/onboarding-app";
import { AppShell } from "../src/shell/app-shell";

export default function HomeScreen() {
  return (
    <AppShell result={readMobileConfig()}>
      {(config) => (
        <>
          <OnboardingApp config={config} />
          <ApiHealthPanel apiBaseUrl={config.apiBaseUrl} />
        </>
      )}
    </AppShell>
  );
}
