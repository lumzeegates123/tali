"use client";

import type { ReadinessResponse } from "@tali/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { TaliApiClient } from "../lib/api-client/tali-api-client";

type HealthState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready" | "not-ready"; readonly readiness: ReadinessResponse; readonly correlationId?: string }
  | { readonly phase: "failed"; readonly failure: ApiFailure };

function describeFailure(failure: ApiFailure): { title: string; detail: string } {
  switch (failure.kind) {
    case "unavailable":
      return {
        title: "Tali API unavailable",
        detail: failure.reason === "timeout" ? "The API did not respond in time." : "The API could not be reached.",
      };
    case "api-error":
      return { title: "Tali API error", detail: `${failure.code}: ${failure.message}` };
    case "invalid-response":
      return { title: "Unexpected API response", detail: `HTTP ${failure.status} did not match the health contract.` };
  }
}

/** Calls `GET /health/ready` and shows loading, ready, not-ready and failure states. */
export function ApiHealth({ client }: { readonly client: TaliApiClient }) {
  const [state, setState] = useState<HealthState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void client.getReadiness().then((result) => {
      if (!active) return;
      if (result.ok) {
        setState({
          phase: result.value.status === "ready" ? "ready" : "not-ready",
          readiness: result.value,
          ...(result.correlationId === undefined ? {} : { correlationId: result.correlationId }),
        });
      } else {
        setState({ phase: "failed", failure: result.failure });
      }
    });
    return () => {
      active = false;
    };
  }, [client, attempt]);

  const retry = useCallback(() => {
    setState({ phase: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  const body = useMemo(() => {
    switch (state.phase) {
      case "loading":
        return <p role="status">Checking the Tali API…</p>;
      case "ready":
      case "not-ready":
        return (
          <>
            <p role="status" data-health={state.phase}>
              {state.phase === "ready" ? "Tali API is ready" : "Tali API is not ready"}
            </p>
            <dl>
              <dt>Database</dt>
              <dd>{state.readiness.checks.database}</dd>
              {state.correlationId === undefined ? null : (
                <>
                  <dt>Correlation ID</dt>
                  <dd>
                    <code>{state.correlationId}</code>
                  </dd>
                </>
              )}
            </dl>
          </>
        );
      case "failed": {
        const { title, detail } = describeFailure(state.failure);
        return (
          <div role="alert" data-health="failed">
            <p>{title}</p>
            <p>{detail}</p>
          </div>
        );
      }
    }
  }, [state]);

  return (
    <section aria-labelledby="api-health-heading">
      <h2 id="api-health-heading">API health</h2>
      {body}
      <button type="button" onClick={retry} disabled={state.phase === "loading"}>
        Check again
      </button>
    </section>
  );
}

/** Builds the browser-side API client from the public API base URL. */
export function ApiHealthPanel({ apiBaseUrl }: { readonly apiBaseUrl: string }) {
  const client = useMemo(
    () => new TaliApiClient({ baseUrl: apiBaseUrl, createCorrelationId: () => crypto.randomUUID() }),
    [apiBaseUrl],
  );
  return <ApiHealth client={client} />;
}
