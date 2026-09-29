"use client";

import { useCallback, useState } from "react";
import type { IdGeneratorCheckReport } from "../lib/ids/id-checks";
import { checkIdGenerator } from "../lib/ids/id-checks";
import { newUuidV7, SecureRandomUnavailableError } from "../lib/ids/uuidv7";

type RuntimeReport =
  | { readonly status: "idle" }
  | { readonly status: "complete"; readonly uuidV7: IdGeneratorCheckReport; readonly sample: string }
  | { readonly status: "refused"; readonly reason: string };

/** Runs the UUIDv7 acceptance checks in this browser on request and prints the result (Playwright spike). */
export function RuntimeChecks() {
  const [report, setReport] = useState<RuntimeReport>({ status: "idle" });

  const run = useCallback(() => {
    try {
      setReport({ status: "complete", uuidV7: checkIdGenerator(newUuidV7), sample: newUuidV7() });
    } catch (error) {
      if (!(error instanceof SecureRandomUnavailableError)) throw error;
      setReport({ status: "refused", reason: error.message });
    }
  }, []);

  return (
    <section aria-labelledby="runtime-checks-heading">
      <h2 id="runtime-checks-heading">Runtime checks</h2>
      <button type="button" onClick={run}>
        Run UUIDv7 checks
      </button>
      <pre data-testid="runtime-checks" data-status={report.status}>
        {JSON.stringify(report, null, 2)}
      </pre>
    </section>
  );
}
