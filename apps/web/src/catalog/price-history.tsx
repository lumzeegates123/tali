"use client";

import type { PriceHistoryEntryResponse } from "@tali/shared";
import { useEffect, useRef, useState } from "react";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { FailureAlert } from "../onboarding/failure-alert";
import { LoadingState } from "../onboarding/screen-heading";
import { useCatalog, useCatalogStore } from "./catalog-context";
import { formatMoney } from "./money-format";

interface HistoryState {
  readonly phase: "loading" | "ready" | "failed";
  readonly items: readonly PriceHistoryEntryResponse[];
  readonly nextCursor: string | null;
  readonly failure: ApiFailure | undefined;
  readonly loadingMore: boolean;
}

/**
 * Price changes in API order, labelled by `priceVersion` (the authoritative
 * sequence); `effectiveAt` is the recorded instant. Page 1 reloads when
 * `refreshKey` changes, for example after a price is set.
 */
export function PriceHistory({ productId, refreshKey }: { readonly productId: string; readonly refreshKey: number }) {
  const store = useCatalogStore();
  const { reference } = useCatalog();
  const [state, setState] = useState<HistoryState>({
    phase: "loading",
    items: [],
    nextCursor: null,
    failure: undefined,
    loadingMore: false,
  });
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setState({ phase: "loading", items: [], nextCursor: null, failure: undefined, loadingMore: false });
    void store.listPriceHistory(productId).then((outcome) => {
      if (current !== generation.current || outcome.status === "ignored") return;
      setState(
        outcome.status === "ok"
          ? {
              phase: "ready",
              items: outcome.value.items,
              nextCursor: outcome.value.nextCursor,
              failure: undefined,
              loadingMore: false,
            }
          : { phase: "failed", items: [], nextCursor: null, failure: outcome.failure, loadingMore: false },
      );
    });
  }, [store, productId, refreshKey, attempt]);

  function more() {
    const cursor = state.nextCursor;
    if (cursor === null || state.loadingMore) return;
    const current = generation.current;
    setState((value) => ({ ...value, loadingMore: true, failure: undefined }));
    void store.listPriceHistory(productId, cursor).then((outcome) => {
      if (current !== generation.current || outcome.status === "ignored") return;
      setState((value) =>
        outcome.status === "ok"
          ? {
              ...value,
              loadingMore: false,
              items: [
                ...value.items,
                ...outcome.value.items.filter((item) => !value.items.some((seen) => seen.id === item.id)),
              ],
              nextCursor: outcome.value.nextCursor,
            }
          : { ...value, loadingMore: false, failure: outcome.failure },
      );
    });
  }

  return (
    <section aria-labelledby="price-history-heading" className="panel">
      <h3 id="price-history-heading">Price changes (by version)</h3>
      {state.phase === "loading" ? <LoadingState label="Loading price changes…" /> : null}
      {state.failure === undefined ? null : (
        <FailureAlert
          failure={state.failure}
          notFoundScope="resource"
          onRetry={() => {
            if (state.phase === "failed") setAttempt((value) => value + 1);
            else more();
          }}
        />
      )}
      {state.phase === "ready" && state.items.length === 0 ? <p>No price has been set.</p> : null}
      {state.items.length === 0 ? null : (
        <table>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Price</th>
              <th scope="col">Recorded at</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.priceVersion}</td>
                <td>{formatMoney(entry.price, reference.currency)}</td>
                <td>{entry.effectiveAt}</td>
                <td>{entry.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {state.nextCursor === null ? null : (
        <div className="actions">
          <button type="button" className="secondary" disabled={state.loadingMore} onClick={more}>
            {state.loadingMore ? "Loading more…" : "Show more price changes"}
          </button>
        </div>
      )}
    </section>
  );
}
