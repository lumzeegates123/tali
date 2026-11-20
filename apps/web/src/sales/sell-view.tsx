"use client";

import { useState } from "react";
import { ViewHeading } from "../catalog/catalog-context";
import { formatMoney } from "../catalog/money-format";
import { describeFailure } from "../lib/api-client/failure-messages";
import { FailureAlert } from "../onboarding/failure-alert";
import { LoadingState } from "../onboarding/screen-heading";
import { type DiscountKind, MAX_TENDER_REFERENCE, MAX_TENDERS, TENDER_LABEL, type TenderMethod } from "./sale-draft";
import { NOT_VERIFIED_HINT, SaleSummary } from "./sale-summary";
import { useSales, useSalesAllowed, useSalesStore } from "./sales-context";

export const UNCONFIRMED_SALE = "Tali could not confirm whether this sale was recorded.";
export const FINAL_TOTAL_NOTE = "Final total is calculated by Tali when the sale is recorded.";
export const CHANGE_NOTE = "Change is calculated by Tali when the sale is recorded.";

const METHODS: readonly TenderMethod[] = ["CASH", "BANK_TRANSFER", "POS_CARD", "OTHER"];

const ADD_RESULT_TEXT = {
  alreadyInCart: "This product is already in the cart. Change its quantity there.",
  priceNotSet: "Price not set",
  cartFull: "The cart is full.",
} as const;

/**
 * The Sell tab (`sales:create`): find active products, build a cart in
 * stock units, enter tenders and record the sale. Prices shown are the
 * catalog's displayed prices; the final total and any change are calculated
 * by Tali when the sale is recorded and shown on the receipt.
 */
export function SellView({ onCheckHistory }: { readonly onCheckHistory: () => void }) {
  const store = useSalesStore();
  const allowed = useSalesAllowed();
  const { reference, search, lines, tenders, checkout, receipt } = useSales();
  const [query, setQuery] = useState("");
  const [addNotice, setAddNotice] = useState<string | undefined>(undefined);
  const currency = reference.currency;
  const locked = checkout.phase !== "editing";

  if (reference.phase === "loading") return <LoadingState label="Loading sales…" />;
  if (reference.phase === "failed" || currency === undefined) {
    return reference.failure === undefined ? null : (
      <FailureAlert
        failure={reference.failure}
        notFoundScope="business"
        onRetry={() => {
          void store.loadReference();
        }}
      />
    );
  }

  if (receipt !== undefined) {
    return (
      <div className="panel">
        <ViewHeading id="receipt-heading">Receipt</ViewHeading>
        <p role="status" className="notice">
          Sale recorded.
        </p>
        <SaleSummary sale={receipt} currency={currency} units={reference.units} />
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              store.clearReceipt();
            }}
          >
            New sale
          </button>
        </div>
      </div>
    );
  }

  const rejection = checkout.serverTotal === undefined ? checkout.failure : undefined;

  return (
    <div className="panel">
      <ViewHeading id="sell-heading">Sell</ViewHeading>
      <form
        role="search"
        aria-label="Find products"
        onSubmit={(event) => {
          event.preventDefault();
          setAddNotice(undefined);
          void store.searchProducts(query);
        }}
      >
        <div className="field">
          <label htmlFor="sale-search">Find a product</label>
          <input
            id="sale-search"
            value={query}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        <div className="actions">
          <button type="submit" className="secondary">
            Search
          </button>
        </div>
      </form>
      {search.phase === "loading" ? <LoadingState label="Searching…" /> : null}
      {search.phase === "failed" && search.failure !== undefined ? (
        <FailureAlert failure={search.failure} notFoundScope="business" />
      ) : null}
      {search.phase === "ready" && search.items.length === 0 ? <p>No active products match.</p> : null}
      {search.items.length === 0 ? null : (
        <ul className="catalog-list" aria-label="Products found">
          {search.items.map((product) => (
            <li key={product.variantId} className="catalog-row">
              <span className="catalog-name">{product.name}</span>
              {product.sku === null ? null : <span>SKU: {product.sku}</span>}
              <span>
                {product.sellingPrice === null
                  ? "Price not set"
                  : `Displayed price: ${formatMoney(product.sellingPrice, currency)} per ${product.stockUnit}`}
              </span>
              <button
                type="button"
                className="secondary"
                aria-label={`Add ${product.name}`}
                disabled={locked || product.sellingPrice === null}
                onClick={() => {
                  const result = store.addProduct(product);
                  setAddNotice(result === "added" || result === "locked" ? undefined : ADD_RESULT_TEXT[result]);
                }}
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
      {addNotice === undefined ? null : (
        <p role="status" className="notice">
          {addNotice}
        </p>
      )}

      <h4>Cart</h4>
      {lines.length === 0 ? <p>The cart is empty.</p> : null}
      {lines.length === 0 ? null : (
        <ul className="catalog-list" aria-label="Cart">
          {lines.map((line) => {
            const errors = checkout.lineErrors[line.variantId] ?? {};
            const notice = checkout.lineNotices[line.variantId];
            const id = `cart-${line.variantId}`;
            return (
              <li key={line.variantId} className="catalog-row" aria-label={line.name}>
                <span className="catalog-name">{line.name}</span>
                <span>
                  Displayed price: {formatMoney(line.displayedPrice, currency)} per {line.stockUnit}
                </span>
                <div className="field">
                  <label htmlFor={`${id}-quantity`}>Quantity ({line.stockUnit})</label>
                  <input
                    id={`${id}-quantity`}
                    inputMode="decimal"
                    autoComplete="off"
                    value={line.quantityText}
                    disabled={locked}
                    aria-invalid={errors.quantity === undefined ? undefined : true}
                    onChange={(event) => {
                      store.updateLine(line.variantId, { quantityText: event.target.value });
                    }}
                  />
                  {errors.quantity === undefined ? null : <p className="field-error">{errors.quantity}</p>}
                </div>
                {allowed.discount ? (
                  <div className="field">
                    <label htmlFor={`${id}-discount-kind`}>Discount</label>
                    <select
                      id={`${id}-discount-kind`}
                      value={line.discountKind}
                      disabled={locked}
                      onChange={(event) => {
                        store.updateLine(line.variantId, { discountKind: event.target.value as DiscountKind });
                      }}
                    >
                      <option value="NONE">No discount</option>
                      <option value="FIXED">Amount off ({currency.code})</option>
                      <option value="PERCENT">Percent off</option>
                    </select>
                    {line.discountKind === "NONE" ? null : (
                      <>
                        <label htmlFor={`${id}-discount`}>
                          {line.discountKind === "FIXED" ? `Discount amount (${currency.code})` : "Discount percent"}
                        </label>
                        <input
                          id={`${id}-discount`}
                          inputMode="decimal"
                          autoComplete="off"
                          value={line.discountText}
                          disabled={locked}
                          aria-invalid={errors.discount === undefined ? undefined : true}
                          onChange={(event) => {
                            store.updateLine(line.variantId, { discountText: event.target.value });
                          }}
                        />
                      </>
                    )}
                    {errors.discount === undefined ? null : <p className="field-error">{errors.discount}</p>}
                  </div>
                ) : null}
                {notice === undefined ? null : (
                  <p role="alert" className="field-error">
                    {notice}
                  </p>
                )}
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Remove ${line.name}`}
                  disabled={locked}
                  onClick={() => {
                    store.removeLine(line.variantId);
                  }}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint">{FINAL_TOTAL_NOTE}</p>

      <h4>Tenders</h4>
      <ul className="catalog-list" aria-label="Tender rows">
        {tenders.map((tender, index) => {
          const errors = checkout.tenderErrors[tender.rowId] ?? {};
          const id = `tender-${tender.rowId}`;
          return (
            <li key={tender.rowId} className="catalog-row" aria-label={`Tender ${index + 1}`}>
              <div className="field">
                <label htmlFor={`${id}-method`}>Method</label>
                <select
                  id={`${id}-method`}
                  value={tender.method}
                  disabled={locked}
                  onChange={(event) => {
                    store.updateTender(tender.rowId, { method: event.target.value as TenderMethod });
                  }}
                >
                  {METHODS.map((method) => (
                    <option key={method} value={method}>
                      {TENDER_LABEL[method]}
                    </option>
                  ))}
                </select>
              </div>
              {tender.method === "CASH" ? null : (
                <p className="hint">
                  <strong>Not verified</strong> {NOT_VERIFIED_HINT}
                </p>
              )}
              <div className="field">
                <label htmlFor={`${id}-amount`}>Amount ({currency.code})</label>
                <input
                  id={`${id}-amount`}
                  inputMode="decimal"
                  autoComplete="off"
                  value={tender.amountText}
                  disabled={locked}
                  aria-invalid={errors.amount === undefined ? undefined : true}
                  onChange={(event) => {
                    store.updateTender(tender.rowId, { amountText: event.target.value });
                  }}
                />
                {errors.amount === undefined ? null : <p className="field-error">{errors.amount}</p>}
              </div>
              {tender.method === "CASH" ? (
                <div className="field">
                  <label htmlFor={`${id}-cash`}>Cash received ({currency.code}, optional)</label>
                  <input
                    id={`${id}-cash`}
                    inputMode="decimal"
                    autoComplete="off"
                    value={tender.cashReceivedText}
                    disabled={locked}
                    aria-invalid={errors.cashReceived === undefined ? undefined : true}
                    onChange={(event) => {
                      store.updateTender(tender.rowId, { cashReceivedText: event.target.value });
                    }}
                  />
                  <p className="hint">{CHANGE_NOTE}</p>
                  {errors.cashReceived === undefined ? null : <p className="field-error">{errors.cashReceived}</p>}
                </div>
              ) : (
                <div className="field">
                  <label htmlFor={`${id}-reference`}>Reference (optional)</label>
                  <input
                    id={`${id}-reference`}
                    autoComplete="off"
                    maxLength={MAX_TENDER_REFERENCE}
                    value={tender.reference}
                    disabled={locked}
                    aria-invalid={errors.reference === undefined ? undefined : true}
                    onChange={(event) => {
                      store.updateTender(tender.rowId, { reference: event.target.value });
                    }}
                  />
                  {errors.reference === undefined ? null : <p className="field-error">{errors.reference}</p>}
                </div>
              )}
              {tenders.length > 1 ? (
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Remove tender ${index + 1}`}
                  disabled={locked}
                  onClick={() => {
                    store.removeTender(tender.rowId);
                  }}
                >
                  Remove tender
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {tenders.length < MAX_TENDERS ? (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={locked}
            onClick={() => {
              store.addTender("CASH");
            }}
          >
            Add tender
          </button>
        </div>
      ) : null}

      {checkout.formError === undefined ? null : (
        <p role="alert" className="field-error">
          {checkout.formError}
        </p>
      )}
      {checkout.serverTotal === undefined ? null : (
        <div role="alert" className="alert">
          {checkout.failure === undefined ? null : <p>{describeFailure(checkout.failure).text}</p>}
          <p>Server total: {formatMoney(checkout.serverTotal, currency)}</p>
          {tenders.length === 1 ? (
            <button
              type="button"
              className="secondary"
              disabled={locked}
              onClick={() => {
                store.useServerTotal();
              }}
            >
              Use the server total as the tender amount
            </button>
          ) : null}
        </div>
      )}
      {rejection === undefined ? null : <FailureAlert failure={rejection} notFoundScope="business" />}
      {checkout.phase === "unconfirmed" ? (
        <div role="alert" className="alert">
          <p>{UNCONFIRMED_SALE}</p>
          <p>Submitting again with the same details never records the sale twice.</p>
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                void store.resubmitSale();
              }}
            >
              Submit again with same details
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                store.discardUnconfirmedSale();
                onCheckHistory();
              }}
            >
              Discard and check Sales history
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button
            type="button"
            disabled={checkout.phase === "submitting" || lines.length === 0}
            onClick={() => {
              void store.submitSale(allowed.discount);
            }}
          >
            {checkout.phase === "submitting" ? "Recording…" : "Record sale"}
          </button>
        </div>
      )}
    </div>
  );
}
