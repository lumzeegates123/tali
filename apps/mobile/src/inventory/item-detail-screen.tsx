import type { InventoryItemResponse, InventoryMovementResponse } from "@tali/shared";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ApiFailure } from "../api/tali-api-client";
import { Button, Field, Heading, Loading, styles } from "../onboarding/ui";
import type { DocumentRef } from "./document-screen";
import {
  definitionFor,
  formatDelta,
  formatInstant,
  formatQuantity,
  MOVEMENT_TYPE_LABEL,
  reasonLabel,
  SOURCE_KIND_LABEL,
} from "./inventory-format";
import {
  InventoryFailure,
  LowStockBadge,
  Notice,
  useAllowed,
  useInventory,
  useInventoryStore,
} from "./inventory-context";
import { itemLabel, type ItemLabel } from "./inventory-store";
import { entryProblemText, thresholdQuantity } from "./quantity-input";
import { DOCUMENT_ACTIONS, type StockDocumentKind } from "./stock-document-screen";

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
export function ItemDetailScreen({
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

  if (state.phase === "loading") return <Loading label="Loading the item…" />;
  if (state.phase === "failed") {
    return (
      <View style={styles.screen}>
        <InventoryFailure failure={state.failure} onRetry={() => void loadItem()} />
        <Button label="Back to stock" onPress={onBack} secondary />
      </View>
    );
  }

  const item = state.item;
  const archived = item.productStatus === "ARCHIVED";
  const actions = DOCUMENT_ACTIONS.filter(
    (action) =>
      allowed.can(action.permission) && !(archived && (action.kind === "opening" || action.kind === "receive")),
  );

  return (
    <View style={styles.screen}>
      <Heading>{item.name}</Heading>
      <Text>SKU: {item.sku ?? "None"}</Text>
      <Text>Barcode: {item.barcode ?? "None"}</Text>
      <Text>Status: {archived ? "Archived" : "Active"}</Text>
      <Text>Stock unit: {item.stockUnit}</Text>
      <Text>On hand: {formatQuantity(item.onHand, units.items)}</Text>
      <LowStockBadge lowStock={item.lowStock} archived={archived} />
      <Text>
        Low-stock threshold: {item.threshold === null ? "Not set" : formatQuantity(item.threshold, units.items)}
      </Text>
      {archived ? (
        <Text style={styles.hint}>
          This product is archived. Its remaining stock can still be adjusted, written off or counted.
        </Text>
      ) : null}
      {actions.length === 0 ? null : (
        <View style={styles.wrap}>
          {actions.map((action) => (
            <Button
              key={action.kind}
              label={action.label}
              secondary
              onPress={() => {
                onForm(action.kind, itemLabel(item));
              }}
            />
          ))}
        </View>
      )}
      {allowed.can("inventory:threshold") ? (
        <ThresholdPanel
          item={item}
          onChanged={async () => {
            await loadItem();
          }}
        />
      ) : null}
      <Text style={styles.label} accessibilityRole="header">
        Stock history
      </Text>
      {history.items.length === 0 && !history.loading && history.failure === undefined ? (
        <Text>No stock movements yet.</Text>
      ) : null}
      {history.items.map((movement) => (
        <View key={movement.movementId} style={styles.card}>
          <Text style={styles.strong}>
            {MOVEMENT_TYPE_LABEL[movement.type]}
            {movement.reversesMovementId === null ? "" : " (reversal)"}
          </Text>
          <Text>
            {movement.businessDate} · {formatInstant(movement.occurredAt)}
          </Text>
          <Text>
            Change: {formatDelta(movement.delta, units.items)} · Balance after:{" "}
            {formatQuantity(movement.balanceAfter, units.items)}
          </Text>
          {movementDetails(movement) === "" ? null : <Text>{movementDetails(movement)}</Text>}
          <Button
            label={`View ${SOURCE_KIND_LABEL[movement.source.kind].toLowerCase()}`}
            secondary
            onPress={() => {
              if (movement.source.kind === "STOCKTAKE") onStocktake(movement.source.id);
              else onDocument({ kind: movement.source.kind, id: movement.source.id });
            }}
          />
        </View>
      ))}
      {history.loading ? <Loading label="Loading stock history…" /> : null}
      {history.failure === undefined ? null : (
        <InventoryFailure
          failure={history.failure}
          onRetry={() => void loadHistory(history.items.length === 0 ? undefined : (history.nextCursor ?? undefined))}
        />
      )}
      {history.nextCursor === null || history.loading ? null : (
        <Button label="Show more history" secondary onPress={() => void loadHistory(history.nextCursor ?? undefined)} />
      )}
      <Button label="Back to stock" onPress={onBack} secondary />
    </View>
  );
}

function movementDetails(movement: InventoryMovementResponse): string {
  return [
    reasonLabel(movement.reasonCode),
    movement.reasonNote,
    movement.pack === null ? undefined : `${movement.pack.count} × ${movement.pack.name}`,
  ]
    .filter((part): part is string => part !== undefined && part !== null && part !== "")
    .join(" · ");
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

  function save() {
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
  }

  return (
    <View style={styles.card}>
      <Text style={styles.strong} accessibilityRole="header">
        Low-stock threshold
      </Text>
      {notice === undefined ? null : <Notice>{notice}</Notice>}
      {failure === undefined ? null : (
        <InventoryFailure
          failure={failure}
          versionConflict={VERSION_CONFLICT_TEXT}
          conflict="A threshold can be set for active products that track stock only."
        />
      )}
      {item.productStatus === "ACTIVE" ? (
        <>
          <Field
            label={`${item.threshold === null ? "Threshold" : "New threshold"} (${item.stockUnit})`}
            hint="Tali marks the item LOW STOCK using this threshold."
            value={text}
            onChangeText={setText}
            editable={!busy}
            keyboardType={(definition?.scale ?? 0) === 0 ? "number-pad" : "decimal-pad"}
            error={error}
          />
          <Button
            label={item.threshold === null ? "Set threshold" : "Change threshold"}
            onPress={save}
            disabled={busy}
            busy={busy}
          />
        </>
      ) : null}
      {item.threshold === null ? null : (
        <Button
          label="Clear threshold"
          secondary
          disabled={busy}
          onPress={() => {
            setNotice(undefined);
            setFailure(undefined);
            setBusy(true);
            void store
              .clearThreshold(item.variantId, { expectedVersion: item.thresholdVersion })
              .then((outcome) => finish(outcome, "Threshold cleared."));
          }}
        />
      )}
    </View>
  );
}
