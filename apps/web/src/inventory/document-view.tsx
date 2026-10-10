"use client";

import type {
  AdjustmentResponse,
  DocumentMovementResponse,
  GoodsReceiptResponse,
  OpeningBatchResponse,
} from "@tali/shared";
import { ReverseDocumentRequestSchema } from "@tali/shared";
import { useCallback, useEffect, useState } from "react";
import { ViewHeading } from "../catalog/catalog-context";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { LoadingState } from "../onboarding/screen-heading";
import { formatDelta, formatInstant, formatQuantity, MOVEMENT_TYPE_LABEL, reasonLabel } from "./inventory-format";
import { InventoryFailure, Notice, useAllowed, useInventory, useInventoryStore } from "./inventory-context";

export interface DocumentRef {
  readonly kind: "OPENING_BATCH" | "GOODS_RECEIPT" | "ADJUSTMENT";
  readonly id: string;
}

type Loaded =
  | { readonly kind: "OPENING_BATCH"; readonly value: OpeningBatchResponse }
  | { readonly kind: "GOODS_RECEIPT"; readonly value: GoodsReceiptResponse }
  | { readonly kind: "ADJUSTMENT"; readonly value: AdjustmentResponse };

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly failure: ApiFailure }
  | { readonly phase: "ready"; readonly document: Loaded };

/**
 * One stock document as the API returns it, with every movement it wrote.
 * Goods receipts, adjustments and write-offs can be reversed (with a reason
 * and a confirmation); opening stock never can. A reversal is a new set of
 * movements written by the API; this view reloads the document afterwards.
 */
export function DocumentView({
  document: ref,
  onBack,
  onUnavailable,
}: {
  readonly document: DocumentRef;
  readonly onBack: () => void;
  readonly onUnavailable: () => void;
}) {
  const store = useInventoryStore();
  const allowed = useAllowed();
  const { units, labels } = useInventory();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    let loaded: Loaded | undefined;
    let failure: ApiFailure | undefined;
    if (ref.kind === "OPENING_BATCH") {
      const outcome = await store.getOpeningBatch(ref.id);
      if (outcome.status === "ok") loaded = { kind: ref.kind, value: outcome.value };
      else if (outcome.status === "failed") failure = outcome.failure;
    } else if (ref.kind === "GOODS_RECEIPT") {
      const outcome = await store.getGoodsReceipt(ref.id);
      if (outcome.status === "ok") loaded = { kind: ref.kind, value: outcome.value };
      else if (outcome.status === "failed") failure = outcome.failure;
    } else {
      const outcome = await store.getAdjustment(ref.id);
      if (outcome.status === "ok") loaded = { kind: ref.kind, value: outcome.value };
      else if (outcome.status === "failed") failure = outcome.failure;
    }
    if (failure !== undefined) {
      if (failure.kind === "api-error" && failure.code === "NOT_FOUND") onUnavailable();
      else setState({ phase: "failed", failure });
    } else if (loaded !== undefined) {
      setState({ phase: "ready", document: loaded });
      void store.ensureLabels(loaded.value.movements.map((movement) => movement.variantId));
    }
  }, [store, ref.kind, ref.id, onUnavailable]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") return <LoadingState label="Loading the document…" />;
  if (state.phase === "failed") {
    return (
      <div className="panel">
        <InventoryFailure failure={state.failure} onRetry={() => void load()} />
        <div className="actions">
          <button type="button" className="secondary" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const loaded = state.document;
  const header = loaded.value.document;
  const title =
    loaded.kind === "OPENING_BATCH"
      ? "Opening stock"
      : loaded.kind === "GOODS_RECEIPT"
        ? "Goods receipt"
        : loaded.value.document.kind === "WRITE_OFF"
          ? "Write-off"
          : "Adjustment";
  const status = loaded.kind === "OPENING_BATCH" ? undefined : loaded.value.document;
  const reversible = status !== undefined && status.status === "POSTED" && allowed.can("inventory:adjust");

  return (
    <div className="panel">
      <ViewHeading id="document-heading">{title}</ViewHeading>
      {notice === undefined ? null : <Notice>{notice}</Notice>}
      <dl>
        <dt>Business date</dt>
        <dd>{header.businessDate}</dd>
        <dt>Recorded</dt>
        <dd>{formatInstant(header.occurredAt)}</dd>
        {status === undefined ? null : (
          <>
            <dt>Status</dt>
            <dd>{status.status === "POSTED" ? "Posted" : "Reversed"}</dd>
          </>
        )}
        {loaded.kind === "GOODS_RECEIPT" ? (
          <>
            <dt>Reference</dt>
            <dd>{loaded.value.document.reference ?? "None"}</dd>
          </>
        ) : null}
        {loaded.kind === "ADJUSTMENT" ? (
          <>
            <dt>Reason</dt>
            <dd>
              {reasonLabel(loaded.value.document.reasonCode)}
              {loaded.value.document.reasonNote === null ? "" : `: ${loaded.value.document.reasonNote}`}
            </dd>
          </>
        ) : null}
        <dt>Note</dt>
        <dd>{header.note ?? "None"}</dd>
        {status?.reversedAt === null || status === undefined ? null : (
          <>
            <dt>Reversed</dt>
            <dd>
              {formatInstant(status.reversedAt)}
              {status.reversalReason === null ? "" : `: ${status.reversalReason}`}
            </dd>
          </>
        )}
      </dl>
      <MovementTable
        caption="Stock movements"
        movements={loaded.value.movements}
        name={(variantId) => labels[variantId]?.name ?? "Item"}
        units={units.items}
      />
      {reversible ? (
        <ReversePanel
          what={loaded.kind === "GOODS_RECEIPT" ? "receipt" : title.toLowerCase()}
          onReverse={async (reason) => {
            const outcome =
              loaded.kind === "GOODS_RECEIPT"
                ? await store.reverseGoodsReceipt(header.id, { reason })
                : await store.reverseAdjustment(header.id, { reason });
            if (outcome.status === "ok") {
              setNotice(
                outcome.value.changed ? `The ${title.toLowerCase()} was reversed.` : "This was already reversed.",
              );
              void load();
              return undefined;
            }
            return outcome.status === "failed" ? outcome.failure : undefined;
          }}
        />
      ) : null}
      <div className="actions">
        <button type="button" className="secondary" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

export function MovementTable({
  caption,
  movements,
  name,
  units,
}: {
  readonly caption: string;
  readonly movements: readonly DocumentMovementResponse[];
  readonly name: (variantId: string) => string;
  readonly units: Parameters<typeof formatQuantity>[1];
}) {
  return (
    <table aria-label={caption}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Type</th>
          <th scope="col">Change</th>
          <th scope="col">Balance after</th>
        </tr>
      </thead>
      <tbody>
        {movements.map((movement) => (
          <tr key={movement.movementId}>
            <td>{name(movement.variantId)}</td>
            <td>
              {MOVEMENT_TYPE_LABEL[movement.type]}
              {movement.reversesMovementId === null ? "" : " (reversal)"}
            </td>
            <td>{formatDelta(movement.delta, units)}</td>
            <td>{formatQuantity(movement.balanceAfter, units)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A reason is required and the reversal is confirmed in a second step. */
function ReversePanel({
  what,
  onReverse,
}: {
  readonly what: string;
  readonly onReverse: (reason: string) => Promise<ApiFailure | undefined>;
}) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);

  return (
    <section aria-labelledby="reverse-heading" className="panel">
      <h4 id="reverse-heading">Reverse this {what}</h4>
      <p className="hint">Reversing writes new movements that undo this one. The original stays in the history.</p>
      <div className="field">
        <label htmlFor="reverse-reason">Reason for reversing</label>
        <textarea
          id="reverse-reason"
          value={reason}
          disabled={busy}
          aria-invalid={error === undefined ? undefined : true}
          onChange={(event) => {
            setReason(event.target.value);
            setConfirming(false);
          }}
        />
        {error === undefined ? null : <p className="field-error">{error}</p>}
      </div>
      {failure === undefined ? null : <InventoryFailure failure={failure} />}
      <div className="actions">
        {confirming ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setFailure(undefined);
                void onReverse(reason.trim()).then((result) => {
                  setBusy(false);
                  setConfirming(false);
                  setFailure(result);
                });
              }}
            >
              {busy ? "Reversing…" : "Confirm reversal"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep it
            </button>
          </>
        ) : (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              if (!ReverseDocumentRequestSchema.safeParse({ reason: reason.trim() }).success || reason.trim() === "") {
                setError("Enter a reason for reversing.");
                return;
              }
              setError(undefined);
              setConfirming(true);
            }}
          >
            Reverse {what}
          </button>
        )}
      </div>
    </section>
  );
}
