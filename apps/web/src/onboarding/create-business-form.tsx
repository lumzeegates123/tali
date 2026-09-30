import type { SyntheticEvent } from "react";
import { useState } from "react";
import { describeFailure, rejectedFields } from "../lib/api-client/failure-messages";
import { useSession, useSessionStore } from "../lib/auth/session-context";
import { detectDeviceTimeZone, PILOT_CURRENCY_CODES } from "../lib/onboarding/create-business-defaults";
import { FailureAlert } from "./failure-alert";
import { ScreenHeading } from "./screen-heading";
import { TextField } from "./text-field";

type Field = "name" | "timeZone" | "currencyCode";

const SERVER_FIELD_TEXT: Record<Field, string> = {
  name: "Tali did not accept this name.",
  timeZone: "Tali did not recognise this time zone. Use an IANA name such as Africa/Lagos.",
  currencyCode: "This currency is not available.",
};

function isField(name: string): name is Field {
  return name === "name" || name === "timeZone" || name === "currencyCode";
}

/**
 * `POST /v1/businesses` (name, currency, time zone). The store keeps one
 * Idempotency-Key per logical submission, so submitting unchanged details
 * again after a failure cannot create a second business.
 */
export function CreateBusinessForm({
  heading,
  onCancel,
}: {
  readonly heading: string;
  readonly onCancel?: (() => void) | undefined;
}) {
  const store = useSessionStore();
  const session = useSession();
  const [name, setName] = useState("");
  const [timeZone, setTimeZone] = useState(detectDeviceTimeZone);
  const [localErrors, setLocalErrors] = useState<Partial<Record<Field, string>>>({});
  const currencyCode = PILOT_CURRENCY_CODES[0];
  const submitting = session.pending === "createBusiness";
  const failure = session.error?.action === "createBusiness" ? session.error.failure : undefined;
  const serverFields = rejectedFields(failure).filter(isField);

  function fieldError(field: Field): string | undefined {
    return localErrors[field] ?? (serverFields.includes(field) ? SERVER_FIELD_TEXT[field] : undefined);
  }

  function submitDetails() {
    const errors: Partial<Record<Field, string>> = {};
    if (name.trim() === "") errors.name = "Enter the business name.";
    if (timeZone.trim() === "") errors.timeZone = "Enter the business time zone, for example Africa/Lagos.";
    setLocalErrors(errors);
    if (Object.keys(errors).length > 0) return;
    void store.createBusiness({ name, currencyCode, timeZone }).then((outcome) => {
      if (outcome.status === "invalid") {
        setLocalErrors(
          Object.fromEntries(
            outcome.fields.filter(isField).map((field) => [field, "This value is too long or not valid."]),
          ),
        );
      }
    });
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    submitDetails();
  }

  const retryable = failure !== undefined && describeFailure(failure).retryable;

  return (
    <section aria-labelledby="create-business-heading" className="onboarding">
      <ScreenHeading id="create-business-heading">{heading}</ScreenHeading>
      <form onSubmit={submit} noValidate aria-busy={submitting}>
        <TextField
          id="business-name"
          label="Business name"
          value={name}
          onChange={setName}
          disabled={submitting}
          error={fieldError("name")}
        />
        <div className="field">
          <p className="label">
            Currency: <strong>{currencyCode}</strong>
          </p>
          <p className="hint">
            The private pilot supports {currencyCode} only. A business keeps its currency once created.
          </p>
          {fieldError("currencyCode") === undefined ? null : (
            <p className="field-error">Error: {fieldError("currencyCode")}</p>
          )}
        </div>
        <TextField
          id="business-time-zone"
          label="Time zone"
          hint="An IANA time-zone name, for example Africa/Lagos. Tali checks it when you create the business."
          value={timeZone}
          onChange={setTimeZone}
          disabled={submitting}
          error={fieldError("timeZone")}
        />
        {failure === undefined || serverFields.length > 0 ? null : (
          <FailureAlert
            failure={failure}
            onRetry={submitDetails}
            retryLabel="Try again with the same details"
            retryDisabled={submitting}
          />
        )}
        {retryable ? (
          <p className="hint">Trying again with unchanged details will not create a second business.</p>
        ) : null}
        <div className="actions">
          <button type="submit" disabled={submitting}>
            {submitting ? "Creating business…" : "Create business"}
          </button>
          {onCancel === undefined ? null : (
            <button type="button" className="secondary" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
