"use client";

import type { StocktakeResponse } from "@tali/shared";
import { useEffect, useState } from "react";
import { ViewHeading } from "../catalog/catalog-context";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { FailureAlert } from "../onboarding/failure-alert";
import { LoadingState } from "../onboarding/screen-heading";
import { formatInstant, STOCKTAKE_STATUS_LABEL } from "./inventory-format";
import { InventoryFailure, useAllowed, useInventory, useInventoryStore } from "./inventory-context";
import type { StocktakeFilter } from "./inventory-store";
import { TextField } from "./stock-document-form";

const FILTER_LABEL: Readonly<Record<StocktakeFilter, string>> = {
  ALL: "All",
  DRAFT: "In progress",
  POSTED: "Posted",
  CANCELLED: "Cancelled",
};

const IN_PROGRESS = "A stocktake is already in progress. Finish or cancel it before starting another.";
const UNCONFIRMED =
  "Tali could not confirm whether the stocktake was started. Start it again to check (only one is created), or discard this attempt.";

export function postingSummary(stocktake: StocktakeResponse): string | undefined {
  if (stocktake.posting === null) return undefined;
  const { correctionMovementCount, zeroVarianceCount } = stocktake.posting;
  return `${correctionMovementCount} stock ${correctionMovementCount === 1 ? "correction" : "corrections"}, ${zeroVarianceCount} with no difference`;
}

/** Stocktakes by status, newest first as the API lists them, and starting a new one. */
export function StocktakesView({ onOpen }: { readonly onOpen: (stocktakeId: string) => void }) {
  const store = useInventoryStore();
  const allowed = useAllowed();
  const { stocktakes, keyed } = useInventory();
  const create = keyed.createStocktake;
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const [inProgress, setInProgress] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    void store.refreshStocktakes();
  }, [store]);

  async function start() {
    setFailure(undefined);
    setInProgress(false);
    setMessage(undefined);
    const outcome = await store.createStocktake(note.trim() === "" ? {} : { note: note.trim() });
    if (outcome.status === "ok") {
      setNote("");
      onOpen(outcome.value.stocktakeId);
    } else if (outcome.status === "failed") {
      if (outcome.failure.kind === "api-error" && outcome.failure.code === "CONFLICT") setInProgress(true);
      else setFailure(outcome.failure);
    } else if (outcome.status === "unconfirmed") setMessage(UNCONFIRMED);
  }

  async function openDraft() {
    const outcome = await store.findDraftStocktake();
    if (outcome.status === "ok") {
      if (outcome.value === undefined) {
        setInProgress(false);
        setMessage("No stocktake is in progress now. You can start one.");
      } else onOpen(outcome.value.stocktakeId);
    } else if (outcome.status === "failed") setFailure(outcome.failure);
  }

  return (
    <div className="panel">
      <ViewHeading id="stocktakes-heading">Stocktakes</ViewHeading>
      {allowed.can("inventory:count") ? (
        <form
          className="panel"
          aria-label="Start a stocktake"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <TextField
            id="stocktake-note"
            label="Note (optional)"
            value={note}
            onChange={setNote}
            disabled={create.unconfirmed || create.inFlight}
          />
          {inProgress ? (
            <div role="alert" className="alert">
              <p>{IN_PROGRESS}</p>
              <button type="button" onClick={() => void openDraft()}>
                Open the stocktake in progress
              </button>
            </div>
          ) : null}
          {failure === undefined ? null : <InventoryFailure failure={failure} conflict={IN_PROGRESS} />}
          {message === undefined && !(create.unconfirmed && !create.inFlight) ? null : (
            <p role="status" className="notice">
              {message ?? UNCONFIRMED}
            </p>
          )}
          <div className="actions">
            <button type="submit" disabled={create.inFlight}>
              {create.inFlight ? "Starting…" : create.unconfirmed ? "Start again" : "Start stocktake"}
            </button>
            {create.unconfirmed && !create.inFlight ? (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  store.discardUnconfirmed("createStocktake");
                  setMessage(undefined);
                }}
              >
                Discard this attempt
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
      <div className="field">
        <label htmlFor="stocktake-filter">Show</label>
        <select
          id="stocktake-filter"
          value={stocktakes.status}
          onChange={(event) => {
            void store.loadStocktakes(event.target.value as StocktakeFilter);
          }}
        >
          {(Object.keys(FILTER_LABEL) as StocktakeFilter[]).map((status) => (
            <option key={status} value={status}>
              {FILTER_LABEL[status]}
            </option>
          ))}
        </select>
      </div>
      {stocktakes.phase === "loading" ? <LoadingState label="Loading stocktakes…" /> : null}
      {stocktakes.phase === "failed" && stocktakes.failure !== undefined ? (
        <FailureAlert
          failure={stocktakes.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.refreshStocktakes();
          }}
        />
      ) : null}
      {stocktakes.phase === "ready" && stocktakes.items.length === 0 ? <p>No stocktakes yet.</p> : null}
      {stocktakes.items.length === 0 ? null : (
        <ul className="catalog-list" aria-label="Stocktakes">
          {stocktakes.items.map((stocktake) => {
            const summary = postingSummary(stocktake);
            const started = formatInstant(stocktake.createdAt);
            return (
              <li key={stocktake.stocktakeId} className="catalog-row">
                <span className="catalog-name">{STOCKTAKE_STATUS_LABEL[stocktake.status]}</span>
                <span>Started {started}</span>
                {stocktake.businessDate === null ? null : <span>Business date {stocktake.businessDate}</span>}
                <span>
                  {stocktake.countedLineCount} {stocktake.countedLineCount === 1 ? "item" : "items"} counted
                </span>
                {stocktake.note === null ? null : <span>{stocktake.note}</span>}
                {summary === undefined ? null : <span>{summary}</span>}
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Open stocktake started ${started}`}
                  onClick={() => {
                    onOpen(stocktake.stocktakeId);
                  }}
                >
                  Open
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {stocktakes.moreFailure === undefined ? null : (
        <FailureAlert
          failure={stocktakes.moreFailure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadMoreStocktakes();
          }}
          retryDisabled={stocktakes.loadingMore}
        />
      )}
      {stocktakes.nextCursor === null || stocktakes.phase !== "ready" ? null : (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={stocktakes.loadingMore}
            onClick={() => {
              void store.loadMoreStocktakes();
            }}
          >
            {stocktakes.loadingMore ? "Loading more…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}
