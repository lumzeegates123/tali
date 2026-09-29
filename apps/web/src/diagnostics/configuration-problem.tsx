import type { ConfigurationIssue } from "@tali/config/public";

/** Shown instead of the app when public configuration is invalid; lists keys and problems, never values. */
export function ConfigurationProblem({ issues }: { readonly issues: readonly ConfigurationIssue[] }) {
  return (
    <section role="alert" aria-labelledby="configuration-heading">
      <h2 id="configuration-heading">Configuration error</h2>
      <p>This build of the Tali web app has invalid public configuration and does not call the API.</p>
      <ul>
        {issues.map((issue) => (
          <li key={issue.key}>
            <code>{issue.key}</code>: {issue.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
