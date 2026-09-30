import type { ReactNode } from "react";
import { ConfigurationProblem } from "../diagnostics/configuration-problem";
import { EnvironmentPanel } from "../diagnostics/environment-panel";
import { ApiHealthPanel } from "../health/api-health";
import type { WebConfigResult } from "../lib/config/web-config";

/** The web shell: header, the page content, then environment diagnostics and API health. */
export function AppShell({ result, children }: { readonly result: WebConfigResult; readonly children?: ReactNode }) {
  return (
    <div className="shell">
      <header className="shell-header">
        <h1>Tali</h1>
        <p>Private pilot</p>
      </header>
      <main className="shell-main">
        {result.ok ? (
          <>
            {children}
            <EnvironmentPanel config={result.config} />
            <ApiHealthPanel apiBaseUrl={result.config.apiBaseUrl} />
          </>
        ) : (
          <ConfigurationProblem issues={result.issues} />
        )}
      </main>
    </div>
  );
}
