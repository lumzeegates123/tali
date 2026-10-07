"use client";

import type { ProductResponse } from "@tali/shared";
import type { SyntheticEvent } from "react";
import { useState } from "react";
import { rejectedFields } from "../lib/api-client/failure-messages";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { FailureAlert } from "../onboarding/failure-alert";
import { TextField } from "../onboarding/text-field";
import type { CatalogAffordances } from "./affordances";
import { useCatalog, useCatalogStore } from "./catalog-context";
import { formatMoney, moneyInputError, moneyInputHint, parseMoneyInput } from "./money-format";

function isCode(failure: ApiFailure | undefined, code: string): boolean {
  return failure?.kind === "api-error" && failure.code === code;
}

/** The current selling price and, with `product:price`, the set-price form (exact decimal input). */
export function PricePanel({
  product,
  allowed,
  onChanged,
  onReload,
  onUnavailable,
}: {
  readonly product: ProductResponse;
  readonly allowed: CatalogAffordances;
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

  function save() {
    if (currency === undefined) return;
    setFailure(undefined);
    const parsed = parseMoneyInput(price, currency);
    if (!parsed.ok) {
      setError(moneyInputError(parsed.reason, currency));
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

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    save();
  }

  return (
    <section aria-labelledby="price-heading" className="panel">
      <h3 id="price-heading">Selling price</h3>
      <p>
        Current price:{" "}
        {product.sellingPrice === null ? "Not set" : formatMoney(product.sellingPrice, reference.currency)}
      </p>
      {!allowed.canPrice ? null : currency === undefined ? (
        reference.phase === "failed" && reference.failure !== undefined ? (
          <FailureAlert
            failure={reference.failure}
            notFoundScope="business"
            onRetry={() => {
              void store.loadReference();
            }}
          />
        ) : (
          <p role="status">Loading the business currency…</p>
        )
      ) : (
        <form onSubmit={submit} noValidate aria-busy={saving}>
          <TextField
            id="price-amount"
            label={`New selling price (${currency.code})`}
            value={price}
            hint={moneyInputHint(currency)}
            onChange={setPrice}
            error={error ?? (rejectedFields(failure).includes("price") ? "This price was not accepted." : undefined)}
            disabled={saving}
          />
          <TextField
            id="price-reason"
            label="Reason (optional)"
            value={reason}
            onChange={setReason}
            disabled={saving}
          />
          {failure === undefined ? null : (
            <FailureAlert failure={failure} notFoundScope="resource" onRetry={save} retryDisabled={saving} />
          )}
          {isCode(failure, "VERSION_CONFLICT") ? (
            <div className="actions">
              <button type="button" onClick={onReload}>
                Reload latest
              </button>
            </div>
          ) : null}
          <div className="actions">
            <button type="submit" disabled={saving}>
              {saving ? "Saving price…" : "Set price"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
