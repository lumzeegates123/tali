import { notFound } from "next/navigation";
import { RuntimeChecks } from "../../../diagnostics/runtime-checks";
import { readWebConfig } from "../../../lib/config/web-config";
import { AppShell } from "../../../shell/app-shell";

/** Non-production runtime diagnostics (UUIDv7 in this browser). Not served in production. */
export default function RuntimeDiagnosticsPage() {
  const result = readWebConfig();
  if (!result.ok || result.config.env === "production") notFound();
  return (
    <AppShell result={result}>
      <RuntimeChecks />
    </AppShell>
  );
}
