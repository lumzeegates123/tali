"use client";

import type { InventoryItemResponse } from "@tali/shared";
import { useEffect } from "react";
import { ViewHeading } from "../catalog/catalog-context";
import { FailureAlert } from "../onboarding/failure-alert";
import { LoadingState } from "../onboarding/screen-heading";
import { formatQuantity } from "./inventory-format";
import { Notice, useAllowed, useInventory, useInventoryStore } from "./inventory-context";

/**
 * Stock needing valuation (ADR-009 section 23): the API's UNVALUED items, with
 * their on-hand quantity and "Cost unknown". No value or average cost is
 * shown. Only roles with `inventory:value` get the Value stock action.
 */
export function NeedsValuationList({
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
    <div className="panel">
      <ViewHeading id="needs-valuation-heading">Needs valuation</ViewHeading>
      {notice === undefined ? null : <Notice>{notice}</Notice>}
      <p className="hint">
        These items have no known cost. Their quantities are correct, but Tali records no cost of goods sold for them
        and inventory value is incomplete until they are valued.
      </p>
      {needsValuation.phase === "loading" ? <LoadingState label="Loading stock needing valuation…" /> : null}
      {needsValuation.phase === "failed" && needsValuation.failure !== undefined ? (
        <FailureAlert
          failure={needsValuation.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadNeedsValuation();
          }}
        />
      ) : null}
      {needsValuation.phase === "ready" && needsValuation.items.length === 0 ? <p>No stock needs valuation.</p> : null}
      {needsValuation.items.length === 0 ? null : (
        <ul className="catalog-list" aria-label="Stock needing valuation">
          {needsValuation.items.map((item) => (
            <li key={item.variantId} className="catalog-row">
              <span className="catalog-name">{item.name}</span>
              <span>SKU: {item.sku ?? "None"}</span>
              <span>Unit: {item.stockUnit}</span>
              <span>On hand: {formatQuantity(item.onHand, units.items)}</span>
              <span>Cost unknown</span>
              {canValue ? (
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Value stock of ${item.name}`}
                  onClick={() => {
                    onValue(item);
                  }}
                >
                  Value stock
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {needsValuation.moreFailure === undefined ? null : (
        <FailureAlert
          failure={needsValuation.moreFailure}
          notFoundScope="business"
          retryDisabled={needsValuation.loadingMore}
          onRetry={() => {
            void store.loadMoreNeedsValuation();
          }}
        />
      )}
      {needsValuation.nextCursor === null || needsValuation.phase !== "ready" ? null : (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={needsValuation.loadingMore}
            onClick={() => {
              void store.loadMoreNeedsValuation();
            }}
          >
            {needsValuation.loadingMore ? "Loading more…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}
