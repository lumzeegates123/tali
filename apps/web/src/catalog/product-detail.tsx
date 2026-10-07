"use client";

import type { ProductResponse } from "@tali/shared";
import { useEffect, useState } from "react";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { FailureAlert } from "../onboarding/failure-alert";
import { LoadingState } from "../onboarding/screen-heading";
import type { CatalogAffordances } from "./affordances";
import { useCatalog, useCatalogStore, ViewHeading } from "./catalog-context";
import { useCategoryLabel } from "./category-label";
import { PacksPanel } from "./packs-panel";
import { PriceHistory } from "./price-history";
import { PricePanel } from "./price-panel";
import { formatMoney } from "./money-format";

type DetailState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly product: ProductResponse }
  | { readonly phase: "failed"; readonly failure: ApiFailure };

function isCode(failure: ApiFailure | undefined, code: string): boolean {
  return failure?.kind === "api-error" && failure.code === code;
}

/** One product with its price, price history and packs. Every action re-checks permission server-side. */
export function ProductDetail({
  productId,
  allowed,
  onBack,
  onEdit,
  onUnavailable,
}: {
  readonly productId: string;
  readonly allowed: CatalogAffordances;
  readonly onBack: () => void;
  readonly onEdit: (product: ProductResponse) => void;
  readonly onUnavailable: () => void;
}) {
  const store = useCatalogStore();
  const { reference } = useCatalog();
  const [state, setState] = useState<DetailState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusFailure, setStatusFailure] = useState<ApiFailure | undefined>(undefined);
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const [historyVersion, setHistoryVersion] = useState(0);
  const product = state.phase === "ready" ? state.product : undefined;
  const categoryLabel = useCategoryLabel(product?.categoryId ?? null);

  useEffect(() => {
    let active = true;
    setState({ phase: "loading" });
    void store.getProduct(productId).then((outcome) => {
      if (!active || outcome.status === "ignored") return;
      if (outcome.status === "failed" && isCode(outcome.failure, "NOT_FOUND")) {
        onUnavailable();
        return;
      }
      setState(
        outcome.status === "ok"
          ? { phase: "ready", product: outcome.value }
          : { phase: "failed", failure: outcome.failure },
      );
    });
    return () => {
      active = false;
    };
  }, [store, productId, attempt, onUnavailable]);

  function changed(next: ProductResponse, message: string) {
    setState({ phase: "ready", product: next });
    setSaved(message);
  }

  function changeStatus(current: ProductResponse) {
    setStatusBusy(true);
    setStatusFailure(undefined);
    setSaved(undefined);
    const request =
      current.status === "ACTIVE"
        ? store.archiveProduct(current.id, { expectedVersion: current.version })
        : store.reactivateProduct(current.id, { expectedVersion: current.version });
    void request.then((outcome) => {
      setStatusBusy(false);
      if (outcome.status === "ok") {
        changed(outcome.value, outcome.value.status === "ARCHIVED" ? "Product archived." : "Product reactivated.");
      } else if (outcome.status === "failed") {
        if (isCode(outcome.failure, "NOT_FOUND")) onUnavailable();
        else setStatusFailure(outcome.failure);
      }
    });
  }

  return (
    <div className="panel">
      <div className="actions">
        <button type="button" className="secondary" onClick={onBack}>
          Back to products
        </button>
      </div>
      {state.phase === "loading" ? (
        <>
          <ViewHeading id="product-heading">Product</ViewHeading>
          <LoadingState label="Loading the product…" />
        </>
      ) : state.phase === "failed" ? (
        <>
          <ViewHeading id="product-heading">Product</ViewHeading>
          <FailureAlert
            failure={state.failure}
            notFoundScope="resource"
            onRetry={() => {
              setAttempt((value) => value + 1);
            }}
          />
        </>
      ) : (
        <>
          <ViewHeading id="product-heading">{state.product.name}</ViewHeading>
          {saved === undefined ? null : <p role="status">{saved}</p>}
          <dl>
            <dt>Status</dt>
            <dd>{state.product.status === "ACTIVE" ? "Active" : "Archived"}</dd>
            <dt>Description</dt>
            <dd>{state.product.description ?? "None"}</dd>
            <dt>Category</dt>
            <dd>{categoryLabel}</dd>
            <dt>SKU</dt>
            <dd>{state.product.sku ?? "None"}</dd>
            <dt>Barcode</dt>
            <dd>{state.product.barcode ?? "None"}</dd>
            <dt>Stock unit</dt>
            <dd>{state.product.stockUnit}</dd>
            <dt>Track inventory</dt>
            <dd>{state.product.trackInventory ? "Yes" : "No"}</dd>
            <dt>Selling price</dt>
            <dd>
              {state.product.sellingPrice === null
                ? "Not set"
                : formatMoney(state.product.sellingPrice, reference.currency)}
            </dd>
          </dl>
          {allowed.canManage ? (
            <div className="actions">
              <button
                type="button"
                onClick={() => {
                  onEdit(state.product);
                }}
              >
                Edit product
              </button>
              <button
                type="button"
                className="secondary"
                disabled={statusBusy}
                onClick={() => {
                  changeStatus(state.product);
                }}
              >
                {state.product.status === "ACTIVE" ? "Archive product" : "Reactivate product"}
              </button>
            </div>
          ) : null}
          {statusFailure === undefined ? null : (
            <>
              <FailureAlert failure={statusFailure} notFoundScope="resource" />
              {isCode(statusFailure, "VERSION_CONFLICT") ? (
                <div className="actions">
                  <button
                    type="button"
                    onClick={() => {
                      setStatusFailure(undefined);
                      setAttempt((value) => value + 1);
                    }}
                  >
                    Reload latest
                  </button>
                </div>
              ) : null}
            </>
          )}
          <PricePanel
            product={state.product}
            allowed={allowed}
            onChanged={(next) => {
              changed(next, "Price saved.");
              setHistoryVersion((value) => value + 1);
            }}
            onReload={() => {
              setAttempt((value) => value + 1);
            }}
            onUnavailable={onUnavailable}
          />
          <PriceHistory productId={state.product.id} refreshKey={historyVersion} />
          <PacksPanel product={state.product} allowed={allowed} />
        </>
      )}
    </div>
  );
}
