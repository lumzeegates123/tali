import type {
  AdjustmentResponse,
  DocumentMovementResponse,
  GoodsReceiptResponse,
  OpeningBatchResponse,
  UnitResponse,
} from "@tali/shared";
import { ReverseDocumentRequestSchema } from "@tali/shared";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ApiFailure } from "../api/tali-api-client";
import { Button, Field, Heading, Loading, styles } from "../onboarding/ui";
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
 * movements written by the API; this screen reloads the document afterwards.
 */
export function DocumentScreen({
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

  if (state.phase === "loading") return <Loading label="Loading the document…" />;
  if (state.phase === "failed") {
    return (
      <View style={styles.screen}>
        <InventoryFailure failure={state.failure} onRetry={() => void load()} />
        <Button label="Back" onPress={onBack} secondary />
      </View>
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
    <View style={styles.screen}>
      <Heading>{title}</Heading>
      {notice === undefined ? null : <Notice>{notice}</Notice>}
      <Text>Business date: {header.businessDate}</Text>
      <Text>Recorded: {formatInstant(header.occurredAt)}</Text>
      {status === undefined ? null : <Text>Status: {status.status === "POSTED" ? "Posted" : "Reversed"}</Text>}
      {loaded.kind === "GOODS_RECEIPT" ? <Text>Reference: {loaded.value.document.reference ?? "None"}</Text> : null}
      {loaded.kind === "ADJUSTMENT" ? (
        <Text>
          Reason: {reasonLabel(loaded.value.document.reasonCode)}
          {loaded.value.document.reasonNote === null ? "" : `: ${loaded.value.document.reasonNote}`}
        </Text>
      ) : null}
      <Text>Note: {header.note ?? "None"}</Text>
      {status === undefined || status.reversedAt === null ? null : (
        <Text>
          Reversed: {formatInstant(status.reversedAt)}
          {status.reversalReason === null ? "" : `: ${status.reversalReason}`}
        </Text>
      )}
      <MovementList
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
      <Button label="Back" onPress={onBack} secondary />
    </View>
  );
}

function MovementList({
  movements,
  name,
  units,
}: {
  readonly movements: readonly DocumentMovementResponse[];
  readonly name: (variantId: string) => string;
  readonly units: readonly UnitResponse[];
}) {
  return (
    <View style={styles.field} accessibilityLabel="Stock movements">
      <Text style={styles.label}>Stock movements</Text>
      {movements.map((movement) => (
        <View key={movement.movementId} style={styles.card}>
          <Text style={styles.strong}>{name(movement.variantId)}</Text>
          <Text>
            {MOVEMENT_TYPE_LABEL[movement.type]}
            {movement.reversesMovementId === null ? "" : " (reversal)"}
          </Text>
          <Text>
            Change: {formatDelta(movement.delta, units)} · Balance after: {formatQuantity(movement.balanceAfter, units)}
          </Text>
        </View>
      ))}
    </View>
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
    <View style={styles.card}>
      <Text style={styles.strong}>Reverse this {what}</Text>
      <Text style={styles.hint}>
        Reversing writes new movements that undo this one. The original stays in the history.
      </Text>
      <Field
        label="Reason for reversing"
        value={reason}
        editable={!busy}
        error={error}
        onChangeText={(text) => {
          setReason(text);
          setConfirming(false);
        }}
      />
      {failure === undefined ? null : <InventoryFailure failure={failure} />}
      {confirming ? (
        <View style={styles.wrap}>
          <Button
            label={busy ? "Reversing…" : "Confirm reversal"}
            disabled={busy}
            busy={busy}
            onPress={() => {
              setBusy(true);
              setFailure(undefined);
              void onReverse(reason.trim()).then((result) => {
                setBusy(false);
                setConfirming(false);
                setFailure(result);
              });
            }}
          />
          <Button
            label="Keep it"
            disabled={busy}
            secondary
            onPress={() => {
              setConfirming(false);
            }}
          />
        </View>
      ) : (
        <Button
          label={`Reverse ${what}`}
          secondary
          onPress={() => {
            if (reason.trim() === "" || !ReverseDocumentRequestSchema.safeParse({ reason: reason.trim() }).success) {
              setError("Enter a reason for reversing.");
              return;
            }
            setError(undefined);
            setConfirming(true);
          }}
        />
      )}
    </View>
  );
}
