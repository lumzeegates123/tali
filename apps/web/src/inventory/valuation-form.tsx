"use client";

import type { InventoryItemResponse } from "@tali/shared";
import { useEffect, useState } from "react";
import { ViewHeading } from "../catalog/catalog-context";
import { moneyInputHint, parseNonNegativeMoneyInput } from "../catalog/money-format";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { FailureAlert } from "../onboarding/failure-alert";
import { LoadingState } from "../onboarding/screen-heading";
import { formatQuantity } from "./inventory-format";
import { InventoryFailure, useInventory, useInventoryStore } from "./inventory-context";

export const MAX_VALUATION_REASON = 500;

export const VALUATION_STALE_TEXT =
  "Stock changed since this valuation was reviewed. Reload the item and enter the value again.";
const ALREADY_VALUED_TEXT = "This item no longer needs valuation. The latest stock details have been loaded.";
const UNCONFIRMED =
  "Tali could not confirm whether this valuation was recorded. Submit again with the same details to check (nothing is recorded twice), or discard it and check the list.";
const CHANGED_WHILE_UNCONFIRMED =
  "The details changed after a submission Tali could not confirm. Submit the original details again, or discard that submission first.";

/**
 * Values an UNVALUED item's current on-hand quantity (ADR-009 section 20):
 * a total value of zero or more in the business currency and a required
 * reason, at the balance version shown. The valuation kind is decided by the
 * API; nothing here computes a unit cost or an average.
 */
export function ValuationForm({
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
    <div className="panel">
      <ViewHeading id="valuation-heading">Value stock</ViewHeading>
      <dl>
        <dt>Item</dt>
        <dd>{item.name}</dd>
        <dt>On hand</dt>
        <dd>{formatQuantity(item.onHand, units.items)}</dd>
        <dt>Stock unit</dt>
        <dd>{item.stockUnit}</dd>
      </dl>
      <p className="hint">
        Enter the total value of all {item.stockUnit} on hand now. Tali records it from now on only; it does not change
        past sales or their cost.
      </p>
      {notice === undefined ? null : (
        <p role="alert" className="notice">
          {notice}
        </p>
      )}
      {currency.phase === "loading" ? <LoadingState label="Loading the business currency…" /> : null}
      {currency.phase === "failed" && currency.failure !== undefined ? (
        <FailureAlert
          failure={currency.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadCurrency();
          }}
        />
      ) : null}
      {definition === undefined ? null : (
        <form
          aria-labelledby="valuation-heading"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="field">
            <label htmlFor="valuation-total">Total value ({definition.code})</label>
            <input
              id="valuation-total"
              inputMode="decimal"
              autoComplete="off"
              value={value}
              disabled={locked}
              aria-invalid={errors.value === undefined ? undefined : true}
              aria-describedby="valuation-total-hint"
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
            <p id="valuation-total-hint" className="hint">
              {moneyInputHint(definition)} Zero is allowed.
            </p>
            {errors.value === undefined ? null : <p className="field-error">{errors.value}</p>}
          </div>
          <div className="field">
            <label htmlFor="valuation-reason">Reason</label>
            <textarea
              id="valuation-reason"
              value={reason}
              maxLength={MAX_VALUATION_REASON}
              disabled={locked}
              aria-invalid={errors.reason === undefined ? undefined : true}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            {errors.reason === undefined ? null : <p className="field-error">{errors.reason}</p>}
          </div>
          {failure === undefined ? null : <InventoryFailure failure={failure} />}
          {state.unconfirmed && !state.inFlight ? (
            <div role="status" className="notice">
              <p>{UNCONFIRMED}</p>
            </div>
          ) : null}
          <div className="actions">
            <button type="submit" disabled={state.inFlight}>
              {state.inFlight ? "Saving…" : state.unconfirmed ? "Submit again" : "Record valuation"}
            </button>
            {state.unconfirmed && !state.inFlight ? (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  store.discardUnconfirmed("stockValuation");
                  setFailure(undefined);
                }}
              >
                Discard this submission
              </button>
            ) : null}
            <button type="button" className="secondary" onClick={onCancel} disabled={state.inFlight}>
              Back to the list
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
