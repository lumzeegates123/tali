"use client";

import type { SaleResponse } from "@tali/shared";
import { useEffect, useState } from "react";
import { ViewHeading } from "../catalog/catalog-context";
import { formatMoney } from "../catalog/money-format";
import { formatInstant } from "../inventory/inventory-format";
import { describeFailure } from "../lib/api-client/failure-messages";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { FailureAlert } from "../onboarding/failure-alert";
import { LoadingState } from "../onboarding/screen-heading";
import { SALE_STATUS_LABEL, SaleSummary } from "./sale-summary";
import { useSales, useSalesAllowed, useSalesStore } from "./sales-context";

export const MAX_REVERSAL_REASON = 500;
export const TENDER_UNWOUND_CONFIRMATION =
  "I confirm that the original tender has been returned or unwound as applicable.";
export const UNCONFIRMED_REVERSAL = "Tali could not confirm whether this sale was reversed.";

/** The Sales tab: sales the caller may read, in the API's order (oldest first), paged. */
export function SalesHistory({ onOpen }: { readonly onOpen: (saleId: string) => void }) {
  const store = useSalesStore();
  const allowed = useSalesAllowed();
  const { history, reference } = useSales();

  useEffect(() => {
    void store.loadHistory();
  }, [store]);

  return (
    <div className="panel">
      <ViewHeading id="sales-history-heading">Sales</ViewHeading>
      <p className="hint">
        {allowed.readAll ? "All sales of this business, oldest first." : "Sales you recorded, oldest first."}
      </p>
      {history.phase === "loading" ? <LoadingState label="Loading sales…" /> : null}
      {history.phase === "failed" && history.failure !== undefined ? (
        <FailureAlert
          failure={history.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadHistory();
          }}
        />
      ) : null}
      {history.phase === "ready" && history.items.length === 0 ? <p>No sales yet.</p> : null}
      {history.items.length === 0 ? null : (
        <ul className="catalog-list" aria-label="Sales">
          {history.items.map((sale) => (
            <li key={sale.saleId} className="catalog-row">
              <span className="catalog-name">Receipt {sale.receiptNumber}</span>
              <span>{SALE_STATUS_LABEL[sale.status]}</span>
              <span>{formatMoney(sale.total, reference.currency)}</span>
              <span>{formatInstant(sale.recordedAt)}</span>
              <button
                type="button"
                className="secondary"
                aria-label={`Open sale ${sale.receiptNumber}`}
                onClick={() => {
                  onOpen(sale.saleId);
                }}
              >
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
      {history.moreFailure === undefined ? null : (
        <FailureAlert
          failure={history.moreFailure}
          notFoundScope="business"
          retryDisabled={history.loadingMore}
          onRetry={() => {
            void store.loadMoreHistory();
          }}
        />
      )}
      {history.nextCursor === null || history.phase !== "ready" ? null : (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={history.loadingMore}
            onClick={() => {
              void store.loadMoreHistory();
            }}
          >
            {history.loadingMore ? "Loading more…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}

type DetailState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly sale: SaleResponse }
  | { readonly phase: "failed"; readonly failure: ApiFailure };

/** One sale from `GET .../sales/:saleId`, with the full reversal for roles that may reverse. */
export function SaleDetail({
  saleId,
  onBack,
  onUnavailable,
}: {
  readonly saleId: string;
  readonly onBack: () => void;
  readonly onUnavailable: () => void;
}) {
  const store = useSalesStore();
  const allowed = useSalesAllowed();
  const { reference } = useSales();
  const [state, setState] = useState<DetailState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [reversed, setReversed] = useState(false);

  useEffect(() => {
    let active = true;
    setState({ phase: "loading" });
    void store.getSale(saleId).then((outcome) => {
      if (!active) return;
      if (outcome.status === "ok") setState({ phase: "ready", sale: outcome.value });
      else if (outcome.status === "failed") {
        if (outcome.failure.kind === "api-error" && outcome.failure.code === "NOT_FOUND") onUnavailable();
        else setState({ phase: "failed", failure: outcome.failure });
      }
    });
    return () => {
      active = false;
    };
  }, [store, saleId, attempt, onUnavailable]);

  return (
    <div className="panel">
      <ViewHeading id="sale-detail-heading">Sale</ViewHeading>
      {state.phase === "loading" ? <LoadingState label="Loading the sale…" /> : null}
      {state.phase === "failed" ? (
        <FailureAlert
          failure={state.failure}
          notFoundScope="resource"
          onRetry={() => {
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
      {state.phase === "ready" ? (
        <>
          <SaleSummary sale={state.sale} currency={reference.currency} units={reference.units} />
          {allowed.reverse && state.sale.status === "POSTED" ? (
            <ReversalForm
              key={state.sale.saleId}
              sale={state.sale}
              onReversed={(sale) => {
                setReversed(true);
                setState({ phase: "ready", sale });
              }}
              onReload={() => {
                setAttempt((value) => value + 1);
              }}
            />
          ) : null}
          {state.sale.status === "REVERSED" ? (
            <p role="status" className="notice">
              {reversed ? "Sale reversed." : "This sale was reversed as an error correction."}
            </p>
          ) : null}
        </>
      ) : null}
      <div className="actions">
        <button type="button" className="secondary" onClick={onBack}>
          Back to sales
        </button>
      </div>
    </div>
  );
}

/**
 * Full reversal of a POSTED sale (`sales:reverse`): an error correction that
 * restores stock and posts the reversing ledger entry. It is not a refund or
 * a return. Sent only after the person confirms the tender was unwound.
 */
function ReversalForm({
  sale,
  onReversed,
  onReload,
}: {
  readonly sale: SaleResponse;
  readonly onReversed: (sale: SaleResponse) => void;
  readonly onReload: () => void;
}) {
  const store = useSalesStore();
  const { reversal } = useSales();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const locked = reversal.inFlight || reversal.unconfirmed;

  useEffect(() => {
    store.resetReversal();
  }, [store]);

  async function submit() {
    setFailure(undefined);
    const trimmed = reason.trim();
    if (trimmed === "") {
      setError("Enter the reason for this correction.");
      return;
    }
    if (trimmed.length > MAX_REVERSAL_REASON) {
      setError(`Use at most ${MAX_REVERSAL_REASON} characters.`);
      return;
    }
    if (!confirmed) {
      setError("Confirm that the original tender has been returned or unwound.");
      return;
    }
    setError(undefined);
    const outcome = await store.reverseSale(sale.saleId, trimmed);
    if (outcome.status === "ok") onReversed(outcome.value);
    else if (outcome.status === "failed") setFailure(outcome.failure);
  }

  return (
    <form
      aria-labelledby="reversal-heading"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h4 id="reversal-heading">Reverse this sale</h4>
      <p className="hint">
        Use this only to correct a sale that was recorded by mistake. It reverses the whole sale, puts tracked stock
        back and records a reversing ledger entry. It is not a refund or a return, and it does not move any money.
      </p>
      <div className="field">
        <label htmlFor="reversal-reason">Reason for the correction</label>
        <textarea
          id="reversal-reason"
          value={reason}
          maxLength={MAX_REVERSAL_REASON}
          disabled={locked}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            disabled={locked}
            onChange={(event) => {
              setConfirmed(event.target.checked);
            }}
          />{" "}
          {TENDER_UNWOUND_CONFIRMATION}
        </label>
      </div>
      {error === undefined ? null : (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {failure === undefined ? null : (
        <div role="alert" className="alert">
          <p>{describeFailure(failure, { notFoundScope: "resource" }).text}</p>
        </div>
      )}
      {reversal.unconfirmed && !reversal.inFlight ? (
        <div role="alert" className="alert">
          <p>{UNCONFIRMED_REVERSAL}</p>
          <p>Submitting again with the same details never reverses the sale twice.</p>
        </div>
      ) : null}
      <div className="actions">
        <button type="submit" disabled={reversal.inFlight}>
          {reversal.inFlight ? "Reversing…" : reversal.unconfirmed ? "Submit again with same details" : "Reverse sale"}
        </button>
        {reversal.unconfirmed && !reversal.inFlight ? (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              store.discardUnconfirmedReversal();
              setFailure(undefined);
              onReload();
            }}
          >
            Discard and check the sale
          </button>
        ) : null}
      </div>
    </form>
  );
}
