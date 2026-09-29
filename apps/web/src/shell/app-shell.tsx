import type { ReactNode } from "react";
import { ConfigurationProblem } from "../diagnostics/configuration-problem";
import { EnvironmentPanel } from "../diagnostics/environment-panel";
import { ApiHealthPanel } from "../health/api-health";
import type { WebConfigResult } from "../lib/config/web-config";

/** The foundation web shell: header, environment diagnostics and API health. No business screens. */
export function AppShell({ result, children }: { readonly result: WebConfigResult; readonly children?: ReactNode }) {
  return (
    <div className="shell">
      <header className="shell-header">
        <h1>Tali</h1>
        <p>Foundation shell</p>
      </header>
      <main className="shell-main">
        {result.ok ? (
          <>
            <EnvironmentPanel config={result.config} />
            <ApiHealthPanel apiBaseUrl={result.config.apiBaseUrl} />
            {children}
          </>
        ) : (
          <ConfigurationProblem issues={result.issues} />
        )}
      </main>
    </div>
  );
}
