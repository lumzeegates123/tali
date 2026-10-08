"use client";

import type { SyntheticEvent } from "react";
import { useEffect, useState } from "react";
import { FailureAlert } from "../onboarding/failure-alert";
import { LoadingState } from "../onboarding/screen-heading";
import type { CatalogAffordances } from "./affordances";
import { useCatalog, useCatalogStore, ViewHeading } from "./catalog-context";
import type { CatalogStatus } from "./catalog-store";
import { formatMoney } from "./money-format";

const STATUS_LABEL: Record<CatalogStatus, string> = { ACTIVE: "Active", ARCHIVED: "Archived" };

/** Server-side search (name, SKU or barcode) with an ACTIVE/ARCHIVED filter and keyset Show more. */
export function ProductList({
  allowed,
  notice,
  focusProductId,
  onOpen,
  onCreate,
}: {
  readonly allowed: CatalogAffordances;
  readonly notice: string | undefined;
  readonly focusProductId: string | undefined;
  readonly onOpen: (productId: string) => void;
  readonly onCreate: () => void;
}) {
  const store = useCatalogStore();
  const { products, reference } = useCatalog();
  const [draft, setDraft] = useState(products.query);

  useEffect(() => {
    if (focusProductId !== undefined) document.getElementById(`open-product-${focusProductId}`)?.focus();
  }, [focusProductId]);

  function search(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    void store.searchProducts(draft, products.status);
  }

  return (
    <div className="panel">
      <ViewHeading id="products-heading">Products</ViewHeading>
      {notice === undefined ? null : (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <form role="search" onSubmit={search} noValidate>
        <div className="field">
          <label htmlFor="product-search">Search name, SKU or barcode</label>
          <input
            id="product-search"
            name="product-search"
            type="search"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </div>
        <fieldset className="field">
          <legend className="label">Status</legend>
          {(["ACTIVE", "ARCHIVED"] as const).map((status) => (
            <label key={status} className="choice">
              <input
                type="radio"
                name="product-status"
                value={status}
                checked={products.status === status}
                onChange={() => {
                  void store.searchProducts(products.query, status);
                }}
              />
              {STATUS_LABEL[status]}
            </label>
          ))}
        </fieldset>
        <div className="actions">
          <button type="submit">Search</button>
          {allowed.canManage ? (
            <button type="button" className="secondary" onClick={onCreate}>
              Create product
            </button>
          ) : null}
        </div>
      </form>
      {products.phase === "loading" ? <LoadingState label="Loading products…" /> : null}
      {products.phase === "failed" && products.failure !== undefined ? (
        <FailureAlert
          failure={products.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.refreshProducts();
          }}
        />
      ) : null}
      {products.phase === "ready" && products.items.length === 0 ? (
        <p role="status">{products.query === "" ? "No products yet." : "No products match this search."}</p>
      ) : null}
      {products.items.length === 0 ? null : (
        <ul className="catalog-list" aria-label="Products">
          {products.items.map((product) => (
            <li key={product.id} className="catalog-row">
              <span className="catalog-name">{product.name}</span>
              <span>SKU: {product.sku ?? "None"}</span>
              <span>Barcode: {product.barcode ?? "None"}</span>
              <span>
                Price:{" "}
                {product.sellingPrice === null ? "Not set" : formatMoney(product.sellingPrice, reference.currency)}
              </span>
              <span>Status: {STATUS_LABEL[product.status]}</span>
              <button
                id={`open-product-${product.id}`}
                type="button"
                className="secondary"
                aria-label={`Open ${product.name}`}
                onClick={() => {
                  onOpen(product.id);
                }}
              >
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
      {products.moreFailure === undefined ? null : (
        <FailureAlert
          failure={products.moreFailure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadMoreProducts();
          }}
          retryDisabled={products.loadingMore}
        />
      )}
      {products.nextCursor === null || products.phase !== "ready" ? null : (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={products.loadingMore}
            onClick={() => {
              void store.loadMoreProducts();
            }}
          >
            {products.loadingMore ? "Loading more…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}
