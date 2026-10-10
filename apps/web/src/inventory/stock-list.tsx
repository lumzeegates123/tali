"use client";

import { useState } from "react";
import { ViewHeading } from "../catalog/catalog-context";
import { FailureAlert } from "../onboarding/failure-alert";
import { LoadingState } from "../onboarding/screen-heading";
import { formatQuantity } from "./inventory-format";
import { Notice, useAllowed, useInventory, useInventoryStore } from "./inventory-context";
import type { StockDocumentKind } from "./stock-document-form";
import { DOCUMENT_ACTIONS } from "./stock-document-form";

/** "LOW STOCK" exactly when the API says so; an archived item never shows it. */
export function LowStockBadge({ lowStock, archived }: { readonly lowStock: boolean; readonly archived: boolean }) {
  return lowStock && !archived ? <strong className="badge-low">LOW STOCK</strong> : null;
}

/** Server-side search (name, SKU or barcode), the API's low-stock filter, and Show more. */
export function StockList({
  notice,
  onOpen,
  onForm,
}: {
  readonly notice: string | undefined;
  readonly onOpen: (variantId: string) => void;
  readonly onForm: (form: StockDocumentKind) => void;
}) {
  const store = useInventoryStore();
  const allowed = useAllowed();
  const { items, units } = useInventory();
  const [draft, setDraft] = useState(items.query);
  const actions = DOCUMENT_ACTIONS.filter((action) => allowed.can(action.permission));

  return (
    <div className="panel">
      <ViewHeading id="stock-heading">Stock</ViewHeading>
      {notice === undefined ? null : <Notice>{notice}</Notice>}
      {actions.length === 0 ? null : (
        <div className="actions">
          {actions.map((action) => (
            <button
              key={action.kind}
              type="button"
              className="secondary"
              onClick={() => {
                onForm(action.kind);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      <form
        role="search"
        aria-label="Search stock"
        onSubmit={(event) => {
          event.preventDefault();
          void store.searchItems(draft, items.lowStockOnly);
        }}
      >
        <div className="field">
          <label htmlFor="stock-search">Search name, SKU or barcode</label>
          <input
            id="stock-search"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </div>
        <label className="choice">
          <input
            type="checkbox"
            checked={items.lowStockOnly}
            onChange={(event) => {
              void store.searchItems(items.query, event.target.checked);
            }}
          />
          Low stock only
        </label>
        <div className="actions">
          <button type="submit">Search</button>
        </div>
      </form>
      {units.phase === "failed" && units.failure !== undefined ? (
        <FailureAlert
          failure={units.failure}
          notFoundScope="business"
          retryLabel="Reload units"
          onRetry={() => {
            void store.loadUnits();
          }}
        />
      ) : null}
      {items.phase === "loading" ? <LoadingState label="Loading stock…" /> : null}
      {items.phase === "failed" && items.failure !== undefined ? (
        <FailureAlert
          failure={items.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.refreshItems();
          }}
        />
      ) : null}
      {items.phase === "ready" && items.items.length === 0 ? (
        <p>
          {items.lowStockOnly
            ? "No items are low on stock."
            : items.query === ""
              ? "No stock items yet. Products that track stock appear here."
              : "No stock items match this search."}
        </p>
      ) : null}
      {items.items.length === 0 ? null : (
        <ul className="catalog-list" aria-label="Stock items">
          {items.items.map((item) => {
            const archived = item.productStatus === "ARCHIVED";
            return (
              <li key={item.variantId} className="catalog-row">
                <span className="catalog-name">{item.name}</span>
                <span>SKU: {item.sku ?? "None"}</span>
                <span>On hand: {formatQuantity(item.onHand, units.items)}</span>
                {archived ? <span>Archived</span> : null}
                <LowStockBadge lowStock={item.lowStock} archived={archived} />
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Open ${item.name}`}
                  onClick={() => {
                    onOpen(item.variantId);
                  }}
                >
                  Open
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {items.moreFailure === undefined ? null : (
        <FailureAlert
          failure={items.moreFailure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadMoreItems();
          }}
          retryDisabled={items.loadingMore}
        />
      )}
      {items.nextCursor === null || items.phase !== "ready" ? null : (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={items.loadingMore}
            onClick={() => {
              void store.loadMoreItems();
            }}
          >
            {items.loadingMore ? "Loading more…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}
