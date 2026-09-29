import { readWebConfig } from "../lib/config/web-config";
import { AppShell } from "../shell/app-shell";

export default function HomePage() {
  return <AppShell result={readWebConfig()} />;
}
