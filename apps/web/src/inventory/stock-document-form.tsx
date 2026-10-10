"use client";

import type { AdjustmentLineWire, RecordAdjustmentRequest, RecordWriteOffRequest, StockLineWire } from "@tali/shared";
import { useState } from "react";
import { ViewHeading } from "../catalog/catalog-context";
import type { InventoryPermission } from "./affordances";
import type { DocumentRef } from "./document-view";
import { ADJUSTMENT_REASON_LABEL, definitionFor, WRITE_OFF_REASON_LABEL } from "./inventory-format";
import { InventoryFailure, useInventory, useInventoryStore } from "./inventory-context";
import type { InventoryOutcome, ItemLabel, KeyedOperation } from "./inventory-store";
import { ItemPicker, QuantityFields, usePacks } from "./quantity-fields";
import {
  adjustmentLine,
  type EntryProblem,
  type EntryResult,
  entryProblemText,
  type QuantityEntry,
  stockLine,
} from "./quantity-input";
import type { ApiFailure } from "../lib/api-client/tali-api-client";

function collect<T>(result: EntryResult<T>, into: T[]): EntryProblem | undefined {
  if (!result.ok) return result.problem;
  into.push(result.value);
  return undefined;
}

export type StockDocumentKind = "opening" | "receive" | "adjust" | "writeOff";

interface DocumentAction {
  readonly kind: StockDocumentKind;
  readonly label: string;
  readonly permission: InventoryPermission;
}

export const DOCUMENT_ACTIONS: readonly DocumentAction[] = [
  { kind: "receive", label: "Receive stock", permission: "inventory:receive" },
  { kind: "opening", label: "Record opening stock", permission: "inventory:opening" },
  { kind: "adjust", label: "Adjust stock", permission: "inventory:adjust" },
  { kind: "writeOff", label: "Write off stock", permission: "inventory:adjust" },
];

const TITLE: Readonly<Record<StockDocumentKind, string>> = {
  opening: "Record opening stock",
  receive: "Receive stock",
  adjust: "Adjust stock",
  writeOff: "Write off stock",
};

const OPERATION: Readonly<Record<StockDocumentKind, KeyedOperation>> = {
  opening: "openingStock",
  receive: "goodsReceipt",
  adjust: "adjustment",
  writeOff: "writeOff",
};

const CONFLICT: Readonly<Record<StockDocumentKind, string>> = {
  opening:
    "Opening stock can be recorded once per item, for active products only. Use Receive stock or Adjust stock instead.",
  receive: "Stock cannot be received for an archived product.",
  adjust: "This adjustment conflicts with the current state of an item. Reload the item and try again.",
  writeOff: "This write-off conflicts with the current state of an item. Reload the item and try again.",
};

type AdjustmentReason = RecordAdjustmentRequest["reasonCode"];
type WriteOffReason = RecordWriteOffRequest["reasonCode"];

interface LineDraft {
  readonly item: ItemLabel;
  readonly entry: QuantityEntry;
  readonly direction: "INCREASE" | "DECREASE";
}

function newLine(item: ItemLabel): LineDraft {
  return { item, entry: { kind: "direct", text: "" }, direction: "INCREASE" };
}

/**
 * Opening stock, goods receipt, adjustment and write-off: one or more lines
 * typed as positive quantities. Adjustments take an explicit direction;
 * receipts take only a reference and a note (no supplier, cost or tax).
 * Values stay in the form after any failure.
 */
export function StockDocumentForm({
  kind,
  initialItem,
  onCancel,
  onSaved,
}: {
  readonly kind: StockDocumentKind;
  readonly initialItem: ItemLabel | undefined;
  readonly onCancel: () => void;
  readonly onSaved: (document: DocumentRef) => void;
}) {
  const store = useInventoryStore();
  const { units, keyed } = useInventory();
  const state = keyed[OPERATION[kind]];
  const [lines, setLines] = useState<readonly LineDraft[]>(initialItem === undefined ? [] : [newLine(initialItem)]);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState<AdjustmentReason | "">("");
  const [writeOffReason, setWriteOffReason] = useState<WriteOffReason | "">("");
  const [reasonNote, setReasonNote] = useState("");
  const [lineErrors, setLineErrors] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const locked = state.unconfirmed || state.inFlight;

  function update(variantId: string, change: Partial<LineDraft>) {
    setLines((current) => current.map((line) => (line.item.variantId === variantId ? { ...line, ...change } : line)));
  }

  async function submit() {
    setFormError(undefined);
    setFailure(undefined);
    if (lines.length === 0) {
      setFormError("Add at least one item.");
      return;
    }
    const errors: Record<string, string> = {};
    const stockLines: StockLineWire[] = [];
    const adjustmentLines: AdjustmentLineWire[] = [];
    for (const line of lines) {
      const definition = definitionFor(units.items, line.item.stockUnit);
      const problem =
        kind === "adjust"
          ? collect(adjustmentLine(line.item.variantId, line.direction, definition, line.entry), adjustmentLines)
          : collect(stockLine(line.item.variantId, definition, line.entry), stockLines);
      if (problem !== undefined) errors[line.item.variantId] = entryProblemText(problem, definition);
    }
    if (kind === "adjust" && adjustmentReason === "") errors["reason"] = "Choose a reason.";
    if (kind === "writeOff" && writeOffReason === "") errors["reason"] = "Choose a reason.";
    setLineErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const noteField = note.trim() === "" ? {} : { note: note.trim() };
    const reasonNoteField = reasonNote.trim() === "" ? {} : { reasonNote: reasonNote.trim() };
    let outcome: InventoryOutcome<{ readonly document: { readonly id: string } }>;
    let documentKind: DocumentRef["kind"];
    switch (kind) {
      case "opening":
        documentKind = "OPENING_BATCH";
        outcome = await store.recordOpeningStock({ lines: stockLines, ...noteField });
        break;
      case "receive":
        documentKind = "GOODS_RECEIPT";
        outcome = await store.postGoodsReceipt({
          lines: stockLines,
          ...(reference.trim() === "" ? {} : { reference: reference.trim() }),
          ...noteField,
        });
        break;
      case "adjust":
        documentKind = "ADJUSTMENT";
        outcome = await store.recordAdjustment({
          lines: adjustmentLines,
          reasonCode: adjustmentReason as AdjustmentReason,
          ...reasonNoteField,
          ...noteField,
        });
        break;
      case "writeOff":
        documentKind = "ADJUSTMENT";
        outcome = await store.recordWriteOff({
          lines: stockLines,
          reasonCode: writeOffReason as WriteOffReason,
          ...reasonNoteField,
          ...noteField,
        });
        break;
    }
    if (outcome.status === "ok") onSaved({ kind: documentKind, id: outcome.value.document.id });
    else if (outcome.status === "failed") setFailure(outcome.failure);
    else if (outcome.status === "unconfirmed") setFormError(UNCONFIRMED);
  }

  return (
    <div className="panel">
      <ViewHeading id="stock-document-heading">{TITLE[kind]}</ViewHeading>
      <form
        className="panel"
        aria-labelledby="stock-document-heading"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ItemPicker
          label="Add an item"
          disabled={locked}
          excluded={lines.map((line) => line.item.variantId)}
          onPick={(item) => {
            setLines((current) => [...current, newLine(item)]);
          }}
        />
        {lines.length === 0 ? <p>No items yet.</p> : null}
        {lines.map((line, index) => (
          <LineEditor
            key={line.item.variantId}
            index={index}
            kind={kind}
            line={line}
            error={lineErrors[line.item.variantId]}
            disabled={locked}
            onChange={(change) => {
              update(line.item.variantId, change);
            }}
            onRemove={() => {
              setLines((current) => current.filter((candidate) => candidate.item.variantId !== line.item.variantId));
            }}
          />
        ))}
        {kind === "adjust" ? (
          <ReasonSelect
            value={adjustmentReason}
            labels={ADJUSTMENT_REASON_LABEL}
            error={lineErrors["reason"]}
            disabled={locked}
            onChange={setAdjustmentReason}
          />
        ) : null}
        {kind === "writeOff" ? (
          <ReasonSelect
            value={writeOffReason}
            labels={WRITE_OFF_REASON_LABEL}
            error={lineErrors["reason"]}
            disabled={locked}
            onChange={setWriteOffReason}
          />
        ) : null}
        {kind === "adjust" || kind === "writeOff" ? (
          <TextField
            id="doc-reason-note"
            label="Reason details (optional)"
            value={reasonNote}
            onChange={setReasonNote}
            disabled={locked}
          />
        ) : null}
        {kind === "receive" ? (
          <TextField
            id="doc-reference"
            label="Reference (optional)"
            value={reference}
            onChange={setReference}
            disabled={locked}
          />
        ) : null}
        <TextField id="doc-note" label="Note (optional)" value={note} onChange={setNote} disabled={locked} />
        {formError === undefined ? null : (
          <p role="alert" className="field-error">
            {formError}
          </p>
        )}
        {failure === undefined ? null : <InventoryFailure failure={failure} conflict={CONFLICT[kind]} />}
        {state.unconfirmed && !state.inFlight ? (
          <div role="status" className="notice">
            <p>{UNCONFIRMED}</p>
          </div>
        ) : null}
        <div className="actions">
          <button type="submit" disabled={state.inFlight}>
            {state.inFlight ? "Saving…" : state.unconfirmed ? "Submit again" : TITLE[kind]}
          </button>
          {state.unconfirmed && !state.inFlight ? (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                store.discardUnconfirmed(OPERATION[kind]);
                setFailure(undefined);
                setFormError(undefined);
              }}
            >
              Discard this submission
            </button>
          ) : null}
          <button type="button" className="secondary" onClick={onCancel} disabled={state.inFlight}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

const UNCONFIRMED =
  "Tali could not confirm whether this was saved. Submit again with the same details to check (nothing is recorded twice), or discard it and check the stock history.";

function LineEditor({
  index,
  kind,
  line,
  error,
  disabled,
  onChange,
  onRemove,
}: {
  readonly index: number;
  readonly kind: StockDocumentKind;
  readonly line: LineDraft;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (change: Partial<LineDraft>) => void;
  readonly onRemove: () => void;
}) {
  const { units } = useInventory();
  const packs = usePacks(line.item.productId);
  const prefix = `line-${index}`;
  return (
    <fieldset className="field line" aria-label={line.item.name}>
      <legend className="catalog-name">
        {line.item.name}
        {line.item.productStatus === "ARCHIVED" ? " (Archived)" : ""}
      </legend>
      {kind === "adjust" ? (
        <div role="radiogroup" aria-label={`Direction for ${line.item.name}`}>
          {(["INCREASE", "DECREASE"] as const).map((direction) => (
            <label key={direction} className="choice">
              <input
                type="radio"
                name={`${prefix}-direction`}
                checked={line.direction === direction}
                disabled={disabled}
                onChange={() => {
                  onChange({ direction });
                }}
              />
              {direction === "INCREASE" ? "Increase" : "Decrease"}
            </label>
          ))}
        </div>
      ) : null}
      <QuantityFields
        idPrefix={prefix}
        label={kind === "writeOff" ? "Quantity written off" : "Quantity"}
        stockUnit={line.item.stockUnit}
        units={units.items}
        packs={packs}
        entry={line.entry}
        error={error}
        disabled={disabled}
        onChange={(entry) => {
          onChange({ entry });
        }}
      />
      <div className="actions">
        <button type="button" className="secondary" disabled={disabled} onClick={onRemove}>
          Remove {line.item.name}
        </button>
      </div>
    </fieldset>
  );
}

function ReasonSelect<R extends string>({
  value,
  labels,
  error,
  disabled,
  onChange,
}: {
  readonly value: R | "";
  readonly labels: Readonly<Record<R, string>>;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: R | "") => void;
}) {
  return (
    <div className="field">
      <label htmlFor="doc-reason">Reason</label>
      <select
        id="doc-reason"
        value={value}
        disabled={disabled}
        aria-invalid={error === undefined ? undefined : true}
        onChange={(event) => {
          onChange(event.target.value as R | "");
        }}
      >
        <option value="">Choose a reason</option>
        {(Object.keys(labels) as R[]).map((code) => (
          <option key={code} value={code}>
            {labels[code]}
          </option>
        ))}
      </select>
      {error === undefined ? null : <p className="field-error">{error}</p>}
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  disabled = false,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}
