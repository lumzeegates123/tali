import type { AdjustmentLineWire, RecordAdjustmentRequest, RecordWriteOffRequest, StockLineWire } from "@tali/shared";
import { useState } from "react";
import { Text, View } from "react-native";
import type { ApiFailure } from "../api/tali-api-client";
import { Choice } from "../catalog/catalog-context";
import { Button, Field, Heading, styles } from "../onboarding/ui";
import type { InventoryPermission } from "./affordances";
import type { DocumentRef } from "./document-screen";
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

const UNCONFIRMED =
  "Tali could not confirm whether this was saved. Submit again with the same details to check (nothing is recorded twice), or discard it and check the stock history.";

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
export function StockDocumentScreen({
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
    <View style={styles.screen}>
      <Heading>{TITLE[kind]}</Heading>
      <ItemPicker
        label="Add an item"
        disabled={locked}
        excluded={lines.map((line) => line.item.variantId)}
        onPick={(item) => {
          setLines((current) => [...current, newLine(item)]);
        }}
      />
      {lines.length === 0 ? <Text>No items yet.</Text> : null}
      {lines.map((line) => (
        <LineEditor
          key={line.item.variantId}
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
        <ReasonChoices
          value={adjustmentReason}
          labels={ADJUSTMENT_REASON_LABEL}
          error={lineErrors["reason"]}
          disabled={locked}
          onChange={setAdjustmentReason}
        />
      ) : null}
      {kind === "writeOff" ? (
        <ReasonChoices
          value={writeOffReason}
          labels={WRITE_OFF_REASON_LABEL}
          error={lineErrors["reason"]}
          disabled={locked}
          onChange={setWriteOffReason}
        />
      ) : null}
      {kind === "adjust" || kind === "writeOff" ? (
        <Field label="Reason details (optional)" value={reasonNote} onChangeText={setReasonNote} editable={!locked} />
      ) : null}
      {kind === "receive" ? (
        <Field label="Reference (optional)" value={reference} onChangeText={setReference} editable={!locked} />
      ) : null}
      <Field label="Note (optional)" value={note} onChangeText={setNote} editable={!locked} />
      {formError === undefined ? null : (
        <Text style={styles.error} accessibilityRole="alert">
          {formError}
        </Text>
      )}
      {failure === undefined ? null : <InventoryFailure failure={failure} conflict={CONFLICT[kind]} />}
      {state.unconfirmed && !state.inFlight && formError === undefined ? (
        <View style={styles.notice} accessibilityLiveRegion="polite">
          <Text>{UNCONFIRMED}</Text>
        </View>
      ) : null}
      <View style={styles.row}>
        <Button
          label={state.inFlight ? "Saving…" : state.unconfirmed ? "Submit again" : TITLE[kind]}
          onPress={() => void submit()}
          disabled={state.inFlight}
          busy={state.inFlight}
        />
        {state.unconfirmed && !state.inFlight ? (
          <Button
            label="Discard this submission"
            onPress={() => {
              store.discardUnconfirmed(OPERATION[kind]);
              setFailure(undefined);
              setFormError(undefined);
            }}
            secondary
          />
        ) : null}
        <Button label="Cancel" onPress={onCancel} disabled={state.inFlight} secondary />
      </View>
    </View>
  );
}

function LineEditor({
  kind,
  line,
  error,
  disabled,
  onChange,
  onRemove,
}: {
  readonly kind: StockDocumentKind;
  readonly line: LineDraft;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (change: Partial<LineDraft>) => void;
  readonly onRemove: () => void;
}) {
  const { units } = useInventory();
  const packs = usePacks(line.item.productId);
  return (
    <View style={styles.card} accessibilityLabel={line.item.name}>
      <Text style={styles.strong}>
        {line.item.name}
        {line.item.productStatus === "ARCHIVED" ? " (Archived)" : ""}
      </Text>
      {kind === "adjust" ? (
        <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={`Direction for ${line.item.name}`}>
          {(["INCREASE", "DECREASE"] as const).map((direction) => (
            <Choice
              key={direction}
              label={direction === "INCREASE" ? "Increase" : "Decrease"}
              selected={line.direction === direction}
              disabled={disabled}
              onPress={() => {
                onChange({ direction });
              }}
            />
          ))}
        </View>
      ) : null}
      <QuantityFields
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
      <Button label={`Remove ${line.item.name}`} onPress={onRemove} disabled={disabled} secondary />
    </View>
  );
}

function ReasonChoices<R extends string>({
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
  readonly onChange: (value: R) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>Reason</Text>
      <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="Reason">
        {(Object.keys(labels) as R[]).map((code) => (
          <Choice
            key={code}
            label={labels[code]}
            selected={value === code}
            disabled={disabled}
            onPress={() => {
              onChange(code);
            }}
          />
        ))}
      </View>
      {error === undefined ? null : (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          Error: {error}
        </Text>
      )}
    </View>
  );
}
