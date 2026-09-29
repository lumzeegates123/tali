import type { PublicConfig } from "@tali/config/public";

/**
 * Non-production diagnostics: which environment this build targets and which
 * API it calls. Shows public configuration only; renders nothing in production.
 */
export function EnvironmentPanel({ config }: { readonly config: PublicConfig }) {
  if (config.env === "production") return null;
  return (
    <section aria-labelledby="environment-heading">
      <h2 id="environment-heading">Environment</h2>
      <dl>
        <dt>Environment</dt>
        <dd data-testid="environment-name">{config.env}</dd>
        <dt>API base URL</dt>
        <dd>
          <code>{config.apiBaseUrl}</code>
        </dd>
        <dt>Sign-in</dt>
        <dd>{config.cognito === undefined ? "not configured" : "public Cognito settings present"}</dd>
      </dl>
    </section>
  );
}
