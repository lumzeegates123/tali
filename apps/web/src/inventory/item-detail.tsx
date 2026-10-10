"use client";

import type { InventoryItemResponse, InventoryMovementResponse } from "@tali/shared";
import { useCallback, useEffect, useState } from "react";
import { ViewHeading } from "../catalog/catalog-context";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { LoadingState } from "../onboarding/screen-heading";
import type { DocumentRef } from "./document-view";
import {
  definitionFor,
  formatDelta,
  formatInstant,
  formatQuantity,
  MOVEMENT_TYPE_LABEL,
  reasonLabel,
  SOURCE_KIND_LABEL,
} from "./inventory-format";
import { InventoryFailure, Notice, useAllowed, useInventory, useInventoryStore } from "./inventory-context";
import { itemLabel, type ItemLabel } from "./inventory-store";
import { entryProblemText, thresholdQuantity } from "./quantity-input";
import { DOCUMENT_ACTIONS, type StockDocumentKind } from "./stock-document-form";
import { LowStockBadge } from "./stock-list";

type ItemState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly failure: ApiFailure }
  | { readonly phase: "ready"; readonly item: InventoryItemResponse };

interface HistoryState {
  readonly items: readonly InventoryMovementResponse[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly failure: ApiFailure | undefined;
}

/** One stock item as the API returns it: on hand, LOW STOCK, threshold, and the movement history. */
export function ItemDetail({
  variantId,
  onBack,
  onUnavailable,
  onForm,
  onDocument,
  onStocktake,
}: {
  readonly variantId: string;
  readonly onBack: () => void;
  readonly onUnavailable: () => void;
  readonly onForm: (form: StockDocumentKind, item: ItemLabel) => void;
  readonly onDocument: (document: DocumentRef) => void;
  readonly onStocktake: (stocktakeId: string) => void;
}) {
  const store = useInventoryStore();
  const allowed = useAllowed();
  const { units } = useInventory();
  const [state, setState] = useState<ItemState>({ phase: "loading" });
  const [history, setHistory] = useState<HistoryState>({
    items: [],
    nextCursor: null,
    loading: true,
    failure: undefined,
  });

  const loadItem = useCallback(async () => {
    const outcome = await store.getItem(variantId);
    if (outcome.status === "ok") setState({ phase: "ready", item: outcome.value });
    else if (outcome.status === "failed") {
      if (outcome.failure.kind === "api-error" && outcome.failure.code === "NOT_FOUND") onUnavailable();
      else setState({ phase: "failed", failure: outcome.failure });
    }
  }, [store, variantId, onUnavailable]);

  const loadHistory = useCallback(
    async (after?: string) => {
      setHistory((current) => ({ ...current, loading: true, failure: undefined }));
      const outcome = await store.listMovements(variantId, after);
      if (outcome.status === "ok") {
        setHistory((current) => {
          const known = new Set(after === undefined ? [] : current.items.map((movement) => movement.movementId));
          const base = after === undefined ? [] : current.items;
          return {
            items: [...base, ...outcome.value.items.filter((movement) => !known.has(movement.movementId))],
            nextCursor: outcome.value.nextCursor,
            loading: false,
            failure: undefined,
          };
        });
      } else {
        setHistory((current) => ({
          ...current,
          loading: false,
          failure: outcome.status === "failed" ? outcome.failure : undefined,
        }));
      }
    },
    [store, variantId],
  );

  useEffect(() => {
    void loadItem();
    void loadHistory();
  }, [loadItem, loadHistory]);

  if (state.phase === "loading") return <LoadingState label="Loading the item…" />;
  if (state.phase === "failed") {
    return (
      <div className="panel">
        <InventoryFailure failure={state.failure} onRetry={() => void loadItem()} />
        <div className="actions">
          <button type="button" className="secondary" onClick={onBack}>
            Back to stock
          </button>
        </div>
      </div>
    );
  }

  const item = state.item;
  const archived = item.productStatus === "ARCHIVED";
  const actions = DOCUMENT_ACTIONS.filter(
    (action) =>
      allowed.can(action.permission) && !(archived && (action.kind === "opening" || action.kind === "receive")),
  );

  return (
    <div className="panel">
      <ViewHeading id="item-heading">{item.name}</ViewHeading>
      <dl>
        <dt>SKU</dt>
        <dd>{item.sku ?? "None"}</dd>
        <dt>Barcode</dt>
        <dd>{item.barcode ?? "None"}</dd>
        <dt>Status</dt>
        <dd>{archived ? "Archived" : "Active"}</dd>
        <dt>Stock unit</dt>
        <dd>{item.stockUnit}</dd>
        <dt>On hand</dt>
        <dd>{formatQuantity(item.onHand, units.items)}</dd>
        <dt>Low stock</dt>
        <dd>{item.lowStock && !archived ? <LowStockBadge lowStock archived={false} /> : "No"}</dd>
        <dt>Low-stock threshold</dt>
        <dd>{item.threshold === null ? "Not set" : formatQuantity(item.threshold, units.items)}</dd>
      </dl>
      {archived ? (
        <p className="hint">
          This product is archived. Its remaining stock can still be adjusted, written off or counted.
        </p>
      ) : null}
      {actions.length === 0 ? null : (
        <div className="actions">
          {actions.map((action) => (
            <button
              key={action.kind}
              type="button"
              className="secondary"
              onClick={() => {
                onForm(action.kind, itemLabel(item));
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      {allowed.can("inventory:threshold") ? (
        <ThresholdPanel
          item={item}
          onChanged={async () => {
            await loadItem();
          }}
        />
      ) : null}
      <section aria-labelledby="history-heading" className="panel">
        <h4 id="history-heading">Stock history</h4>
        {history.items.length === 0 && !history.loading && history.failure === undefined ? (
          <p>No stock movements yet.</p>
        ) : null}
        {history.items.length === 0 ? null : (
          <table aria-label="Stock history">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Type</th>
                <th scope="col">Change</th>
                <th scope="col">Balance after</th>
                <th scope="col">Details</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {history.items.map((movement) => (
                <tr key={movement.movementId}>
                  <td>
                    {movement.businessDate}
                    <br />
                    <span className="hint">{formatInstant(movement.occurredAt)}</span>
                  </td>
                  <td>
                    {MOVEMENT_TYPE_LABEL[movement.type]}
                    {movement.reversesMovementId === null ? "" : " (reversal)"}
                  </td>
                  <td>{formatDelta(movement.delta, units.items)}</td>
                  <td>{formatQuantity(movement.balanceAfter, units.items)}</td>
                  <td>
                    {[
                      reasonLabel(movement.reasonCode),
                      movement.reasonNote,
                      movement.pack === null ? undefined : `${movement.pack.count} × ${movement.pack.name}`,
                    ]
                      .filter((part): part is string => part !== undefined && part !== null && part !== "")
                      .join(" · ")}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        if (movement.source.kind === "STOCKTAKE") onStocktake(movement.source.id);
                        else onDocument({ kind: movement.source.kind, id: movement.source.id });
                      }}
                    >
                      View {SOURCE_KIND_LABEL[movement.source.kind].toLowerCase()}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {history.loading ? <LoadingState label="Loading stock history…" /> : null}
        {history.failure === undefined ? null : (
          <InventoryFailure
            failure={history.failure}
            onRetry={() => void loadHistory(history.items.length === 0 ? undefined : (history.nextCursor ?? undefined))}
          />
        )}
        {history.nextCursor === null || history.loading ? null : (
          <div className="actions">
            <button
              type="button"
              className="secondary"
              onClick={() => void loadHistory(history.nextCursor ?? undefined)}
            >
              Show more history
            </button>
          </div>
        )}
      </section>
      <div className="actions">
        <button type="button" className="secondary" onClick={onBack}>
          Back to stock
        </button>
      </div>
    </div>
  );
}

const VERSION_CONFLICT_TEXT =
  "The threshold was changed by someone else. The latest threshold is shown; check it and try again.";

/**
 * Set, change or clear the low-stock threshold with the threshold version the
 * API returned (0 before the first one). Setting needs an ACTIVE product;
 * clearing works on any. After a change, or a VERSION_CONFLICT, the item is
 * reloaded; nothing is retried with a guessed version.
 */
function ThresholdPanel({
  item,
  onChanged,
}: {
  readonly item: InventoryItemResponse;
  readonly onChanged: () => Promise<void>;
}) {
  const store = useInventoryStore();
  const { units } = useInventory();
  const definition = definitionFor(units.items, item.stockUnit);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function finish(outcome: Awaited<ReturnType<typeof store.setThreshold>>, done: string) {
    setBusy(false);
    if (outcome.status === "ok") {
      setNotice(done);
      setText("");
      await onChanged();
    } else if (outcome.status === "failed") {
      setFailure(outcome.failure);
      if (outcome.failure.kind === "api-error" && outcome.failure.code === "VERSION_CONFLICT") await onChanged();
    }
  }

  return (
    <section aria-labelledby="threshold-heading" className="panel">
      <h4 id="threshold-heading">Low-stock threshold</h4>
      {notice === undefined ? null : <Notice>{notice}</Notice>}
      {failure === undefined ? null : (
        <InventoryFailure
          failure={failure}
          versionConflict={VERSION_CONFLICT_TEXT}
          conflict="A threshold can be set for active products that track stock only."
        />
      )}
      {item.productStatus === "ACTIVE" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setNotice(undefined);
            setFailure(undefined);
            const quantity = thresholdQuantity(definition, text);
            if (!quantity.ok) {
              setError(entryProblemText(quantity.problem, definition));
              return;
            }
            setError(undefined);
            setBusy(true);
            void store
              .setThreshold(item.variantId, { expectedVersion: item.thresholdVersion, threshold: quantity.value })
              .then((outcome) => finish(outcome, "Threshold saved."));
          }}
        >
          <div className="field">
            <label htmlFor="threshold-quantity">
              {item.threshold === null ? "Threshold" : "New threshold"} ({item.stockUnit})
            </label>
            <input
              id="threshold-quantity"
              inputMode="decimal"
              autoComplete="off"
              value={text}
              disabled={busy}
              aria-invalid={error === undefined ? undefined : true}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
            <p className="hint">Tali marks the item LOW STOCK using this threshold.</p>
            {error === undefined ? null : <p className="field-error">{error}</p>}
          </div>
          <div className="actions">
            <button type="submit" disabled={busy}>
              {item.threshold === null ? "Set threshold" : "Change threshold"}
            </button>
          </div>
        </form>
      ) : null}
      {item.threshold === null ? null : (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setNotice(undefined);
              setFailure(undefined);
              setBusy(true);
              void store
                .clearThreshold(item.variantId, { expectedVersion: item.thresholdVersion })
                .then((outcome) => finish(outcome, "Threshold cleared."));
            }}
          >
            Clear threshold
          </button>
        </div>
      )}
    </section>
  );
}
