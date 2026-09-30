import { readWebConfig } from "../lib/config/web-config";
import { OnboardingApp } from "../onboarding/onboarding-app";
import { AppShell } from "../shell/app-shell";

export default function HomePage() {
  const result = readWebConfig();
  return <AppShell result={result}>{result.ok ? <OnboardingApp config={result.config} /> : null}</AppShell>;
}
