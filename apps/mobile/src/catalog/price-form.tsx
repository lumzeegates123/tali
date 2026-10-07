import type { ProductResponse } from "@tali/shared";
import { useState } from "react";
import { Text, View } from "react-native";
import { rejectedFields } from "../api/failure-messages";
import type { ApiFailure } from "../api/tali-api-client";
import { Button, FailureNotice, Field, Loading, styles } from "../onboarding/ui";
import { useCatalog, useCatalogStore } from "./catalog-context";
import { moneyInputError, moneyInputHint, parseMoneyInput } from "./money-format";

function isCode(failure: ApiFailure | undefined, code: string): boolean {
  return failure?.kind === "api-error" && failure.code === code;
}

/** Set-price form (`product:price`): exact decimal input in the business currency, with the loaded version. */
export function PriceForm({
  product,
  onChanged,
  onReload,
  onUnavailable,
}: {
  readonly product: ProductResponse;
  readonly onChanged: (product: ProductResponse) => void;
  readonly onReload: () => void;
  readonly onUnavailable: () => void;
}) {
  const store = useCatalogStore();
  const { reference } = useCatalog();
  const [price, setPrice] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const currency = reference.currency;

  if (currency === undefined) {
    return reference.phase === "failed" && reference.failure !== undefined ? (
      <FailureNotice
        failure={reference.failure}
        notFoundScope="business"
        onRetry={() => {
          void store.loadReference();
        }}
      />
    ) : (
      <Loading label="Loading the business currency…" />
    );
  }
  const definition = currency;

  function save() {
    setFailure(undefined);
    const parsed = parseMoneyInput(price, definition);
    if (!parsed.ok) {
      setError(moneyInputError(parsed.reason, definition));
      return;
    }
    setError(undefined);
    setSaving(true);
    void store
      .setSellingPrice(product.id, {
        expectedVersion: product.version,
        price: parsed.value,
        ...(reason === "" ? {} : { reason }),
      })
      .then((outcome) => {
        setSaving(false);
        if (outcome.status === "ok") {
          setPrice("");
          setReason("");
          onChanged(outcome.value);
        } else if (outcome.status === "failed") {
          if (isCode(outcome.failure, "NOT_FOUND")) onUnavailable();
          else setFailure(outcome.failure);
        }
      });
  }

  return (
    <View style={styles.screen}>
      <Field
        label={`New selling price (${definition.code})`}
        hint={moneyInputHint(definition)}
        value={price}
        onChangeText={setPrice}
        editable={!saving}
        error={error ?? (rejectedFields(failure).includes("price") ? "This price was not accepted." : undefined)}
      />
      <Field label="Reason (optional)" value={reason} onChangeText={setReason} editable={!saving} />
      {failure === undefined ? null : (
        <FailureNotice failure={failure} notFoundScope="resource" onRetry={save} retryDisabled={saving} />
      )}
      {isCode(failure, "VERSION_CONFLICT") ? <Button label="Reload latest" onPress={onReload} /> : null}
      <Button label={saving ? "Saving price…" : "Set price"} onPress={save} disabled={saving} busy={saving} />
      <Text style={styles.hint}>The price is checked by Tali against the latest version of this product.</Text>
    </View>
  );
}
