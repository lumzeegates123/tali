import type { InventoryItemResponse } from "@tali/shared";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ApiFailure } from "../api/tali-api-client";
import { moneyInputHint, parseNonNegativeMoneyInput } from "../catalog/money-format";
import { Button, FailureNotice, Field, Heading, Loading, styles } from "../onboarding/ui";
import { formatQuantity } from "./inventory-format";
import { InventoryFailure, Notice, useAllowed, useInventory, useInventoryStore } from "./inventory-context";

export const MAX_VALUATION_REASON = 500;
export const VALUATION_STALE_TEXT =
  "Stock changed since this valuation was reviewed. Reload the item and enter the value again.";
const ALREADY_VALUED_TEXT = "This item no longer needs valuation. The latest stock details have been loaded.";
const UNCONFIRMED =
  "Tali could not confirm whether this valuation was recorded. Submit again with the same details to check (nothing is recorded twice), or discard it and check the list.";
const CHANGED_WHILE_UNCONFIRMED =
  "The details changed after a submission Tali could not confirm. Submit the original details again, or discard that submission first.";

/**
 * Stock needing valuation (ADR-009 section 23): the API's UNVALUED items, with
 * their on-hand quantity and "Cost unknown". No value or average cost is
 * shown. Only roles with `inventory:value` get the Value stock action.
 */
export function NeedsValuationScreen({
  notice,
  onValue,
}: {
  readonly notice: string | undefined;
  readonly onValue: (item: InventoryItemResponse) => void;
}) {
  const store = useInventoryStore();
  const allowed = useAllowed();
  const { needsValuation, units } = useInventory();
  const canValue = allowed.can("inventory:value");

  useEffect(() => {
    void store.loadNeedsValuation();
  }, [store]);

  return (
    <View style={styles.screen}>
      <Heading>Needs valuation</Heading>
      {notice === undefined ? null : <Notice>{notice}</Notice>}
      <Text style={styles.hint}>
        These items have no known cost. Their quantities are correct, but Tali records no cost of goods sold for them
        and inventory value is incomplete until they are valued.
      </Text>
      {needsValuation.phase === "loading" ? <Loading label="Loading stock needing valuation…" /> : null}
      {needsValuation.phase === "failed" && needsValuation.failure !== undefined ? (
        <FailureNotice
          failure={needsValuation.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadNeedsValuation();
          }}
        />
      ) : null}
      {needsValuation.phase === "ready" && needsValuation.items.length === 0 ? (
        <Text>No stock needs valuation.</Text>
      ) : null}
      {needsValuation.items.map((item) => (
        <View key={item.variantId} style={styles.card} accessibilityLabel={`Needs valuation ${item.name}`}>
          <Text style={styles.strong}>{item.name}</Text>
          <Text>SKU: {item.sku ?? "None"}</Text>
          <Text>Unit: {item.stockUnit}</Text>
          <Text>On hand: {formatQuantity(item.onHand, units.items)}</Text>
          <Text>Cost unknown</Text>
          {canValue ? (
            <Button
              label={`Value stock of ${item.name}`}
              secondary
              onPress={() => {
                onValue(item);
              }}
            />
          ) : null}
        </View>
      ))}
      {needsValuation.moreFailure === undefined ? null : (
        <FailureNotice
          failure={needsValuation.moreFailure}
          notFoundScope="business"
          retryDisabled={needsValuation.loadingMore}
          onRetry={() => {
            void store.loadMoreNeedsValuation();
          }}
        />
      )}
      {needsValuation.nextCursor === null || needsValuation.phase !== "ready" ? null : (
        <Button
          label={needsValuation.loadingMore ? "Loading more…" : "Show more"}
          secondary
          disabled={needsValuation.loadingMore}
          onPress={() => {
            void store.loadMoreNeedsValuation();
          }}
        />
      )}
    </View>
  );
}

/**
 * Values an UNVALUED item's current on-hand quantity (ADR-009 section 20):
 * a total value of zero or more in the business currency and a required
 * reason, at the balance version shown. The valuation kind is decided by the
 * API; nothing here computes a unit cost or an average.
 */
export function ValuationScreen({
  item: initial,
  onCancel,
  onSaved,
}: {
  readonly item: InventoryItemResponse;
  readonly onCancel: () => void;
  readonly onSaved: (notice: string) => void;
}) {
  const store = useInventoryStore();
  const { units, currency, keyed } = useInventory();
  const state = keyed.stockValuation;
  const [item, setItem] = useState(initial);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ readonly value?: string; readonly reason?: string }>({});
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const locked = state.inFlight || state.unconfirmed;
  const definition = currency.definition;

  useEffect(() => {
    if (store.getSnapshot().currency.phase !== "ready") void store.loadCurrency();
  }, [store]);

  async function reload(message: string) {
    setNotice(message);
    const outcome = await store.getItem(item.variantId);
    if (outcome.status === "ok") setItem(outcome.value);
    void store.loadNeedsValuation();
  }

  async function submit() {
    setFailure(undefined);
    setNotice(undefined);
    if (definition === undefined) return;
    const parsed = parseNonNegativeMoneyInput(value, definition);
    const trimmedReason = reason.trim();
    const next: { value?: string; reason?: string } = {};
    if (!parsed.ok) {
      next.value =
        parsed.reason === "empty"
          ? "Enter the total value of the stock on hand."
          : parsed.reason === "negative"
            ? "The total value cannot be negative."
            : parsed.reason === "tooLarge"
              ? "This value is too large."
              : moneyInputHint(definition);
    }
    if (trimmedReason === "") next.reason = "Enter a reason for this valuation.";
    else if (trimmedReason.length > MAX_VALUATION_REASON) {
      next.reason = `Use at most ${MAX_VALUATION_REASON} characters.`;
    }
    setErrors(next);
    if (!parsed.ok || next.reason !== undefined) return;
    const outcome = await store.recordStockValuation({
      variantId: item.variantId,
      expectedBalanceVersion: item.balanceVersion,
      newTotalValue: parsed.value,
      reason: trimmedReason,
    });
    if (outcome.status === "ok") {
      onSaved(
        outcome.value.kind === "INITIAL_OPENING" ? "Opening valuation recorded." : "Operational valuation recorded.",
      );
    } else if (outcome.status === "unconfirmed") {
      setNotice(CHANGED_WHILE_UNCONFIRMED);
    } else if (outcome.status === "failed") {
      const code = outcome.failure.kind === "api-error" ? outcome.failure.code : undefined;
      if (code === "VALUATION_STALE") await reload(VALUATION_STALE_TEXT);
      else if (code === "CONFLICT") await reload(ALREADY_VALUED_TEXT);
      else setFailure(outcome.failure);
    }
  }

  return (
    <View style={styles.screen}>
      <Heading>Value stock</Heading>
      <Text style={styles.strong}>{item.name}</Text>
      <Text>On hand: {formatQuantity(item.onHand, units.items)}</Text>
      <Text>Stock unit: {item.stockUnit}</Text>
      <Text style={styles.hint}>
        Enter the total value of all {item.stockUnit} on hand now. Tali records it from now on only; it does not change
        past sales or their cost.
      </Text>
      {notice === undefined ? null : (
        <View style={styles.alert} accessibilityRole="alert">
          <Text>{notice}</Text>
        </View>
      )}
      {currency.phase === "loading" ? <Loading label="Loading the business currency…" /> : null}
      {currency.phase === "failed" && currency.failure !== undefined ? (
        <FailureNotice
          failure={currency.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadCurrency();
          }}
        />
      ) : null}
      {definition === undefined ? null : (
        <>
          <Field
            label={`Total value (${definition.code})`}
            hint={`${moneyInputHint(definition)} Zero is allowed.`}
            value={value}
            keyboardType="decimal-pad"
            editable={!locked}
            error={errors.value}
            onChangeText={setValue}
          />
          <Field label="Reason" value={reason} editable={!locked} error={errors.reason} onChangeText={setReason} />
          {failure === undefined ? null : <InventoryFailure failure={failure} />}
          {state.unconfirmed && !state.inFlight ? (
            <View style={styles.alert} accessibilityRole="alert">
              <Text>{UNCONFIRMED}</Text>
            </View>
          ) : null}
          <Button
            label={state.inFlight ? "Saving…" : state.unconfirmed ? "Submit again" : "Record valuation"}
            disabled={state.inFlight}
            busy={state.inFlight}
            onPress={() => {
              void submit();
            }}
          />
          {state.unconfirmed && !state.inFlight ? (
            <Button
              label="Discard this submission"
              secondary
              onPress={() => {
                store.discardUnconfirmed("stockValuation");
                setFailure(undefined);
              }}
            />
          ) : null}
        </>
      )}
      <Button label="Back to the list" secondary disabled={state.inFlight} onPress={onCancel} />
    </View>
  );
}
