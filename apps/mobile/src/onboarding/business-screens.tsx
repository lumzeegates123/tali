import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { describeFailure, rejectedFields } from "../api/failure-messages";
import { useSession, useSessionStore } from "../auth/session-context";
import type { BusinessOverview, ResourceResult } from "../auth/session-store";
import { detectDeviceTimeZone, PILOT_CURRENCY_CODES } from "./create-business-defaults";
import { roleLabel } from "./role-label";
import { Button, FailureNotice, Field, Heading, Loading, styles } from "./ui";

type FormField = "name" | "timeZone" | "currencyCode";

const SERVER_FIELD_TEXT: Record<FormField, string> = {
  name: "Tali did not accept this name.",
  timeZone: "Tali did not recognise this time zone. Use an IANA name such as Africa/Lagos.",
  currencyCode: "This currency is not available.",
};

function isField(name: string): name is FormField {
  return name === "name" || name === "timeZone" || name === "currencyCode";
}

/**
 * `POST /v1/businesses` (name, currency, time zone). The session keeps one
 * Idempotency-Key per logical submission, so submitting unchanged details
 * again after a failure cannot create a second business.
 */
export function CreateBusinessScreen({
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
  const [localErrors, setLocalErrors] = useState<Partial<Record<FormField, string>>>({});
  const currencyCode = PILOT_CURRENCY_CODES[0];
  const submitting = session.pending === "createBusiness";
  const failure = session.error?.action === "createBusiness" ? session.error.failure : undefined;
  const serverFields = rejectedFields(failure).filter(isField);
  const retryable = failure !== undefined && describeFailure(failure).retryable;

  function fieldError(field: FormField): string | undefined {
    return localErrors[field] ?? (serverFields.includes(field) ? SERVER_FIELD_TEXT[field] : undefined);
  }

  function submit() {
    const errors: Partial<Record<FormField, string>> = {};
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

  return (
    <View style={styles.screen}>
      <Heading>{heading}</Heading>
      <Field
        label="Business name"
        value={name}
        onChangeText={setName}
        editable={!submitting}
        error={fieldError("name")}
      />
      <View style={styles.field}>
        <Text style={styles.label}>Currency: {currencyCode}</Text>
        <Text style={styles.hint}>
          The private pilot supports {currencyCode} only. A business keeps its currency once created.
        </Text>
        {fieldError("currencyCode") === undefined ? null : (
          <Text style={styles.error}>Error: {fieldError("currencyCode")}</Text>
        )}
      </View>
      <Field
        label="Time zone"
        hint="An IANA time-zone name, for example Africa/Lagos. Tali checks it when you create the business."
        value={timeZone}
        onChangeText={setTimeZone}
        editable={!submitting}
        error={fieldError("timeZone")}
      />
      {failure === undefined || serverFields.length > 0 ? null : (
        <FailureNotice
          failure={failure}
          onRetry={submit}
          retryLabel="Try again with the same details"
          retryDisabled={submitting}
        />
      )}
      {retryable ? (
        <Text style={styles.hint}>Trying again with unchanged details will not create a second business.</Text>
      ) : null}
      <Button
        label={submitting ? "Creating business…" : "Create business"}
        onPress={submit}
        disabled={submitting}
        busy={submitting}
      />
      {onCancel === undefined ? null : <Button label="Cancel" onPress={onCancel} disabled={submitting} secondary />}
    </View>
  );
}

/** Only the businesses `GET /v1/me/businesses` returned; with none, the create screen is shown. */
export function BusinessPickerScreen() {
  const store = useSessionStore();
  const session = useSession();
  const [creating, setCreating] = useState(false);

  if (session.businesses.length === 0) return <CreateBusinessScreen heading="Create your first business" />;
  if (creating) {
    return (
      <CreateBusinessScreen
        heading="Create another business"
        onCancel={() => {
          setCreating(false);
        }}
      />
    );
  }
  const loadingMore = session.pending === "loadMoreBusinesses";
  const failure = session.error?.action === "loadBusinesses" ? session.error.failure : undefined;

  return (
    <View style={styles.screen}>
      <Heading>Choose a business</Heading>
      {session.businesses.map(({ business, membership }) => (
        <Pressable
          key={business.id}
          accessibilityRole="button"
          accessibilityLabel={`Open ${business.name}`}
          onPress={() => {
            store.selectBusiness(business.id);
          }}
          style={styles.card}
        >
          <Text style={styles.strong}>{business.name}</Text>
          <Text>
            {business.currencyCode} · {business.timeZone} · {roleLabel(membership.role)}
          </Text>
        </Pressable>
      ))}
      {loadingMore ? <Loading label="Loading more businesses…" /> : null}
      {failure === undefined ? null : (
        <FailureNotice
          failure={failure}
          onRetry={() => {
            void store.loadMoreBusinesses();
          }}
        />
      )}
      {session.businessesNextCursor === null ? null : (
        <Button
          label="Show more businesses"
          onPress={() => {
            void store.loadMoreBusinesses();
          }}
          disabled={loadingMore}
          secondary
        />
      )}
      <Button
        label="Create another business"
        onPress={() => {
          setCreating(true);
        }}
        secondary
      />
    </View>
  );
}

/** The selected business from the API: name, currency, time zone and default location. No metrics. */
export function BusinessOverviewScreen({ businessId }: { readonly businessId: string }) {
  const store = useSessionStore();
  const session = useSession();
  const [result, setResult] = useState<ResourceResult<BusinessOverview> | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const summary = session.businesses.find((item) => item.business.id === businessId);

  useEffect(() => {
    let active = true;
    setResult(undefined);
    void store.loadBusinessOverview(businessId).then((loaded) => {
      if (active) setResult(loaded);
    });
    return () => {
      active = false;
    };
  }, [store, businessId, attempt]);

  return (
    <View style={styles.screen}>
      {result === undefined ? (
        <>
          <Heading>Business overview</Heading>
          <Loading label="Loading the business…" />
        </>
      ) : result.ok ? (
        <>
          <Heading>{result.value.business.name}</Heading>
          <Text testID="overview-currency">Currency: {result.value.business.currencyCode}</Text>
          <Text testID="overview-time-zone">Time zone: {result.value.business.timeZone}</Text>
          <Text testID="overview-default-location">Default location: {result.value.defaultLocation.name}</Text>
          {summary === undefined ? null : <Text>Your role: {roleLabel(summary.membership.role)}</Text>}
        </>
      ) : (
        <>
          <Heading>Business overview</Heading>
          <FailureNotice
            failure={result.failure}
            onRetry={() => {
              setAttempt((value) => value + 1);
            }}
          />
        </>
      )}
      <Button
        label="Switch business"
        onPress={() => {
          store.changeBusiness();
        }}
        secondary
      />
    </View>
  );
}
