"use client";

import type { StocktakeLineResponse, StocktakeResponse } from "@tali/shared";
import { useCallback, useEffect, useState } from "react";
import { ViewHeading } from "../catalog/catalog-context";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { LoadingState } from "../onboarding/screen-heading";
import { definitionFor, formatDelta, formatInstant, formatQuantity, STOCKTAKE_STATUS_LABEL } from "./inventory-format";
import { InventoryFailure, Notice, useAllowed, useInventory, useInventoryStore } from "./inventory-context";
import type { ItemLabel } from "./inventory-store";
import { ItemPicker, QuantityFields, usePacks } from "./quantity-fields";
import { entryProblemText, type QuantityEntry, stocktakeCount } from "./quantity-input";
import { postingSummary } from "./stocktakes-view";
import { TextField } from "./stock-document-form";

export const STALE_MESSAGE = "Some stock changed while you were counting. Recount the affected items before posting.";
const LINE_VERSION_CONFLICT =
  "This count changed since it was loaded. The latest counts are shown; check the item and count it again.";
const STOCKTAKE_VERSION_CONFLICT =
  "The stocktake changed since it was loaded. The latest is shown; review it and try again.";
const NOT_IN_PROGRESS = "This stocktake is no longer in progress. The latest is shown.";

type DetailState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly failure: ApiFailure }
  | {
      readonly phase: "ready";
      readonly stocktake: StocktakeResponse;
      readonly lines: readonly StocktakeLineResponse[];
      readonly truncated: boolean;
    };

interface CountTarget {
  readonly variantId: string;
  readonly name: string;
  readonly stockUnit: string;
  readonly productId: string | undefined;
}

interface Stale {
  readonly variantIds: ReadonlySet<string>;
  readonly lineCount: number;
}

function isStaleFailure(failure: ApiFailure | undefined): boolean {
  return failure?.kind === "api-error" && failure.code === "STOCKTAKE_STALE";
}

function placeLine(lines: readonly StocktakeLineResponse[], line: StocktakeLineResponse): StocktakeLineResponse[] {
  const others = lines.filter((candidate) => candidate.variantId !== line.variantId);
  const index = others.findIndex((candidate) => candidate.variantId > line.variantId);
  return index === -1 ? [...others, line] : [...others.slice(0, index), line, ...others.slice(index)];
}

/**
 * One stocktake. Counting screens render the API's lines as they come: a
 * BLIND line has no expected quantity or variance and none is fetched or
 * shown from anywhere else; a FULL line shows the fields the API returns.
 * Recounts and removals send the line version as last read, posting and
 * cancelling the stocktake version. STOCKTAKE_STALE marks the stale lines and
 * reloads; nothing is resubmitted automatically.
 */
export function StocktakeDetail({
  stocktakeId,
  onBack,
  onUnavailable,
}: {
  readonly stocktakeId: string;
  readonly onBack: () => void;
  readonly onUnavailable: () => void;
}) {
  const store = useInventoryStore();
  const allowed = useAllowed();
  const { units, labels } = useInventory();
  const [state, setState] = useState<DetailState>({ phase: "loading" });
  const [stale, setStale] = useState<Stale>({ variantIds: new Set(), lineCount: 0 });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<
    { readonly failure: ApiFailure; readonly versionConflict: string } | undefined
  >(undefined);
  const [target, setTarget] = useState<CountTarget | undefined>(undefined);
  const [confirm, setConfirm] = useState<"post" | "cancel" | undefined>(undefined);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [header, lines] = await Promise.all([store.getStocktake(stocktakeId), store.loadStocktakeLines(stocktakeId)]);
    const failed = header.status === "failed" ? header.failure : lines.status === "failed" ? lines.failure : undefined;
    if (failed !== undefined) {
      if (failed.kind === "api-error" && failed.code === "NOT_FOUND") onUnavailable();
      else setState({ phase: "failed", failure: failed });
      return;
    }
    if (header.status !== "ok" || lines.status !== "ok") return;
    setState({ phase: "ready", stocktake: header.value, lines: lines.value.lines, truncated: lines.value.truncated });
    void store.ensureLabels(lines.value.lines.map((line) => line.variantId));
  }, [store, stocktakeId, onUnavailable]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") return <LoadingState label="Loading the stocktake…" />;
  if (state.phase === "failed") {
    return (
      <div className="panel">
        <InventoryFailure failure={state.failure} onRetry={() => void load()} />
        <div className="actions">
          <button type="button" className="secondary" onClick={onBack}>
            Back to stocktakes
          </button>
        </div>
      </div>
    );
  }

  const { stocktake, lines, truncated } = state;
  const draft = stocktake.status === "DRAFT";
  const canCount = draft && allowed.can("inventory:count");
  const canFinish = draft && stocktake.visibility === "FULL" && allowed.can("inventory:count-post");
  const full = stocktake.visibility === "FULL" && lines.every((line) => line.visibility === "FULL");
  const summary = postingSummary(stocktake);

  function nameOf(variantId: string): string {
    const label = labels[variantId];
    return label === undefined ? "Loading item…" : label === null ? "Item not available" : label.name;
  }

  function apply(next: { readonly stocktake: StocktakeResponse; readonly line: StocktakeLineResponse }) {
    setState((current) =>
      current.phase === "ready"
        ? { ...current, stocktake: next.stocktake, lines: placeLine(current.lines, next.line) }
        : current,
    );
  }

  /** Shows the failure and reloads when the API says our copy is out of date. */
  function failed(outcomeFailure: ApiFailure, versionConflict: string) {
    setFailure({ failure: outcomeFailure, versionConflict });
    if (outcomeFailure.kind !== "api-error") return;
    if (outcomeFailure.code === "STOCKTAKE_STALE") {
      const details = outcomeFailure.stale;
      setStale({ variantIds: new Set(details?.staleVariantIds ?? []), lineCount: details?.staleLineCount ?? 0 });
      void load();
    } else if (outcomeFailure.code === "VERSION_CONFLICT" || outcomeFailure.code === "CONFLICT") {
      void load();
    }
  }

  async function post() {
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    const outcome = await store.postStocktake(stocktake.stocktakeId, { expectedVersion: stocktake.version });
    setBusy(false);
    setConfirm(undefined);
    if (outcome.status === "ok") {
      setStale({ variantIds: new Set(), lineCount: 0 });
      setNotice(
        outcome.value.changed
          ? "Stocktake posted. Stock now matches the counts."
          : "This stocktake was already posted.",
      );
      void load();
    } else if (outcome.status === "failed") failed(outcome.failure, STOCKTAKE_VERSION_CONFLICT);
  }

  async function cancel() {
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    const reason = cancelReason.trim();
    const outcome = await store.cancelStocktake(stocktake.stocktakeId, {
      expectedVersion: stocktake.version,
      ...(reason === "" ? {} : { reason }),
    });
    setBusy(false);
    setConfirm(undefined);
    if (outcome.status === "ok") {
      setNotice(
        outcome.value.changed ? "Stocktake cancelled. No stock was changed." : "This stocktake was already cancelled.",
      );
      setState((current) => (current.phase === "ready" ? { ...current, stocktake: outcome.value.stocktake } : current));
    } else if (outcome.status === "failed") failed(outcome.failure, STOCKTAKE_VERSION_CONFLICT);
  }

  async function remove(line: StocktakeLineResponse) {
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    const outcome = await store.removeLine(stocktake.stocktakeId, line.variantId, { expectedVersion: line.version });
    setBusy(false);
    if (outcome.status === "ok") {
      apply(outcome.value);
      setNotice(`${nameOf(line.variantId)} removed from this stocktake.`);
    } else if (outcome.status === "failed") failed(outcome.failure, LINE_VERSION_CONFLICT);
  }

  return (
    <div className="panel">
      <ViewHeading id="stocktake-heading">Stocktake</ViewHeading>
      {notice === undefined ? null : <Notice>{notice}</Notice>}
      <dl>
        <dt>Status</dt>
        <dd>{STOCKTAKE_STATUS_LABEL[stocktake.status]}</dd>
        <dt>Started</dt>
        <dd>{formatInstant(stocktake.createdAt)}</dd>
        {stocktake.businessDate === null ? null : (
          <>
            <dt>Business date</dt>
            <dd>{stocktake.businessDate}</dd>
          </>
        )}
        {stocktake.postedAt === null ? null : (
          <>
            <dt>Posted</dt>
            <dd>{formatInstant(stocktake.postedAt)}</dd>
          </>
        )}
        {stocktake.cancelledAt === null ? null : (
          <>
            <dt>Cancelled</dt>
            <dd>{formatInstant(stocktake.cancelledAt)}</dd>
          </>
        )}
        <dt>Note</dt>
        <dd>{stocktake.note ?? "None"}</dd>
        <dt>Items counted</dt>
        <dd>{stocktake.countedLineCount}</dd>
        {summary === undefined ? null : (
          <>
            <dt>Result</dt>
            <dd>{summary}</dd>
          </>
        )}
      </dl>
      {stocktake.visibility === "BLIND" && draft ? (
        <p className="hint">Count what is on the shelf. Expected quantities are not shown while counting.</p>
      ) : null}
      {stale.variantIds.size === 0 && !isStaleFailure(failure?.failure) ? null : (
        <div role="alert" className="alert">
          <p>{STALE_MESSAGE}</p>
          {stale.lineCount > stale.variantIds.size ? (
            <p>
              {stale.lineCount} items are affected; the first {stale.variantIds.size} are marked below.
            </p>
          ) : null}
        </div>
      )}
      {failure === undefined || isStaleFailure(failure.failure) ? null : (
        <InventoryFailure
          failure={failure.failure}
          versionConflict={failure.versionConflict}
          conflict={NOT_IN_PROGRESS}
        />
      )}
      {canCount ? (
        <CountForm
          key={target?.variantId ?? "new"}
          stocktakeId={stocktake.stocktakeId}
          target={target}
          lines={lines}
          truncated={truncated}
          onPick={(item) => {
            store.rememberLabel(item);
            setTarget({
              variantId: item.variantId,
              name: item.name,
              stockUnit: item.stockUnit,
              productId: item.productId,
            });
          }}
          onClear={() => {
            setTarget(undefined);
          }}
          onSaved={(result, name) => {
            apply(result);
            setStale((current) => {
              if (!current.variantIds.has(result.line.variantId)) return current;
              const variantIds = new Set(current.variantIds);
              variantIds.delete(result.line.variantId);
              return { variantIds, lineCount: current.lineCount };
            });
            setTarget(undefined);
            setFailure(undefined);
            setNotice(`Count saved for ${name}.`);
          }}
          onFailed={(outcomeFailure) => {
            failed(outcomeFailure, LINE_VERSION_CONFLICT);
          }}
        />
      ) : null}
      {truncated ? <p className="hint">Only the first {lines.length} counted items are shown.</p> : null}
      {lines.length === 0 ? (
        <p>No items counted yet.</p>
      ) : (
        <table aria-label="Counted items">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Counted</th>
              {full ? <th scope="col">Expected</th> : null}
              {full ? <th scope="col">Difference</th> : null}
              <th scope="col">Status</th>
              {canCount ? <th scope="col">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const name = nameOf(line.variantId);
              const removed = line.status === "REMOVED";
              const isStale = stale.variantIds.has(line.variantId);
              return (
                <tr key={line.variantId} className={removed ? "removed" : isStale ? "stale" : undefined}>
                  <td>{name}</td>
                  <td>{removed ? "Removed" : formatQuantity(line.countedQuantity, units.items)}</td>
                  {full && line.visibility === "FULL" ? <FullCells line={line} /> : null}
                  <td>
                    {isStale ? (
                      <strong>Stock changed while counting. Recount.</strong>
                    ) : removed ? (
                      "Removed"
                    ) : (
                      `Counted ${formatInstant(line.countedAt)}`
                    )}
                  </td>
                  {canCount ? (
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`Recount ${name}`}
                          disabled={busy}
                          onClick={() => {
                            const label = labels[line.variantId];
                            setTarget({
                              variantId: line.variantId,
                              name,
                              stockUnit: line.stockUnit,
                              productId: label === undefined || label === null ? undefined : label.productId,
                            });
                          }}
                        >
                          {removed ? "Count again" : "Recount"}
                        </button>
                        {removed ? null : (
                          <button
                            type="button"
                            className="secondary"
                            aria-label={`Remove ${name}`}
                            disabled={busy}
                            onClick={() => void remove(line)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {canFinish ? (
        <section aria-labelledby="finish-heading" className="panel">
          <h4 id="finish-heading">Finish the stocktake</h4>
          {confirm === "post" ? (
            <div role="alertdialog" aria-label="Confirm posting" className="notice">
              <p>
                Posting sets the stock of every counted item to its counted quantity. This cannot be undone; a later
                stocktake or adjustment can correct it.
              </p>
              <div className="actions">
                <button type="button" disabled={busy} onClick={() => void post()}>
                  {busy ? "Posting…" : "Confirm post"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(undefined);
                  }}
                >
                  Keep counting
                </button>
              </div>
            </div>
          ) : confirm === "cancel" ? (
            <div role="alertdialog" aria-label="Confirm cancelling" className="notice">
              <p>Cancelling discards the counts. No stock changes.</p>
              <TextField
                id="cancel-reason"
                label="Reason (optional)"
                value={cancelReason}
                onChange={setCancelReason}
                disabled={busy}
              />
              <div className="actions">
                <button type="button" disabled={busy} onClick={() => void cancel()}>
                  {busy ? "Cancelling…" : "Confirm cancel"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(undefined);
                  }}
                >
                  Keep the stocktake
                </button>
              </div>
            </div>
          ) : (
            <div className="actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirm("post");
                }}
              >
                Post stocktake
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setConfirm("cancel");
                }}
              >
                Cancel stocktake
              </button>
            </div>
          )}
        </section>
      ) : null}
      <div className="actions">
        <button type="button" className="secondary" onClick={onBack}>
          Back to stocktakes
        </button>
      </div>
    </div>
  );
}

/** Only a FULL line has these fields; the type makes a BLIND line impossible here. */
function FullCells({ line }: { readonly line: Extract<StocktakeLineResponse, { visibility: "FULL" }> }) {
  const { units } = useInventory();
  return (
    <>
      <td>{formatQuantity(line.expectedAtCount, units.items)}</td>
      <td>{line.variance === null ? "Not posted" : formatDelta(line.variance, units.items)}</td>
    </>
  );
}

function CountForm({
  stocktakeId,
  target,
  lines,
  truncated,
  onPick,
  onClear,
  onSaved,
  onFailed,
}: {
  readonly stocktakeId: string;
  readonly target: CountTarget | undefined;
  readonly lines: readonly StocktakeLineResponse[];
  readonly truncated: boolean;
  readonly onPick: (item: ItemLabel) => void;
  readonly onClear: () => void;
  readonly onSaved: (
    result: { readonly stocktake: StocktakeResponse; readonly line: StocktakeLineResponse },
    name: string,
  ) => void;
  readonly onFailed: (failure: ApiFailure) => void;
}) {
  const store = useInventoryStore();
  const { units } = useInventory();
  const packs = usePacks(target?.productId);
  const [entry, setEntry] = useState<QuantityEntry>({ kind: "direct", text: "" });
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const existing = target === undefined ? undefined : lines.find((line) => line.variantId === target.variantId);

  if (target === undefined) {
    return <ItemPicker label="Find an item to count" onPick={onPick} />;
  }
  const definition = definitionFor(units.items, target.stockUnit);

  async function save(current: CountTarget) {
    const count = stocktakeCount(definition, entry);
    if (!count.ok) {
      setError(entryProblemText(count.problem, definition));
      return;
    }
    setError(undefined);
    setBusy(true);
    // A recount sends the line version as last read; a first count sends none.
    const outcome = await store.recordCount(stocktakeId, current.variantId, {
      count: count.value,
      ...(existing === undefined ? {} : { expectedVersion: existing.version }),
    });
    setBusy(false);
    if (outcome.status === "ok") onSaved(outcome.value, current.name);
    else if (outcome.status === "failed") onFailed(outcome.failure);
  }

  return (
    <form
      className="panel"
      aria-label={`Count ${target.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save(target);
      }}
    >
      <h4>
        {existing === undefined ? "Count" : "Recount"} {target.name}
      </h4>
      {existing === undefined && truncated ? (
        <p className="hint">If this item was counted already, Tali asks you to recount it from the list.</p>
      ) : null}
      <QuantityFields
        idPrefix="count"
        label="Counted quantity"
        stockUnit={target.stockUnit}
        units={units.items}
        packs={packs}
        entry={entry}
        onChange={setEntry}
        allowLoose
        error={error}
        disabled={busy}
      />
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save count"}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onClear}>
          Choose another item
        </button>
      </div>
    </form>
  );
}
