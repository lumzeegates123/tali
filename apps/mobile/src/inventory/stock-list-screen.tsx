import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button, FailureNotice, Field, Heading, Loading, styles } from "../onboarding/ui";
import { formatQuantity } from "./inventory-format";
import { LowStockBadge, Notice, Toggle, useAllowed, useInventory, useInventoryStore } from "./inventory-context";
import { DOCUMENT_ACTIONS, type StockDocumentKind } from "./stock-document-screen";

/** Server-side search (name, SKU or barcode), the API's low-stock filter, and Show more. */
export function StockListScreen({
  notice,
  onOpen,
  onForm,
}: {
  readonly notice: string | undefined;
  readonly onOpen: (variantId: string) => void;
  readonly onForm: (form: StockDocumentKind) => void;
}) {
  const store = useInventoryStore();
  const allowed = useAllowed();
  const { items, units } = useInventory();
  const [draft, setDraft] = useState(items.query);
  const actions = DOCUMENT_ACTIONS.filter((action) => allowed.can(action.permission));

  return (
    <View style={styles.screen}>
      <Heading>Stock</Heading>
      {notice === undefined ? null : <Notice>{notice}</Notice>}
      {actions.length === 0 ? null : (
        <View style={styles.row}>
          {actions.map((action) => (
            <Button
              key={action.kind}
              label={action.label}
              onPress={() => {
                onForm(action.kind);
              }}
              secondary
            />
          ))}
        </View>
      )}
      <Field label="Search name, SKU or barcode" value={draft} onChangeText={setDraft} />
      <View style={styles.row}>
        <Button
          label="Search"
          onPress={() => {
            void store.searchItems(draft, items.lowStockOnly);
          }}
        />
        <Toggle
          label="Low stock only"
          checked={items.lowStockOnly}
          onPress={() => {
            void store.searchItems(items.query, !items.lowStockOnly);
          }}
        />
      </View>
      {units.phase === "failed" && units.failure !== undefined ? (
        <FailureNotice
          failure={units.failure}
          notFoundScope="business"
          retryLabel="Reload units"
          onRetry={() => {
            void store.loadUnits();
          }}
        />
      ) : null}
      {items.phase === "loading" ? <Loading label="Loading stock…" /> : null}
      {items.phase === "failed" && items.failure !== undefined ? (
        <FailureNotice
          failure={items.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.refreshItems();
          }}
        />
      ) : null}
      {items.phase === "ready" && items.items.length === 0 ? (
        <Text>
          {items.lowStockOnly
            ? "No items are low on stock."
            : items.query === ""
              ? "No stock items yet. Products that track stock appear here."
              : "No stock items match this search."}
        </Text>
      ) : null}
      {items.items.map((item) => {
        const archived = item.productStatus === "ARCHIVED";
        return (
          <Pressable
            key={item.variantId}
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.name}`}
            onPress={() => {
              onOpen(item.variantId);
            }}
            style={styles.card}
          >
            <Text style={styles.strong}>{item.name}</Text>
            <Text>SKU: {item.sku ?? "None"}</Text>
            <Text>On hand: {formatQuantity(item.onHand, units.items)}</Text>
            {archived ? <Text>Archived</Text> : null}
            <LowStockBadge lowStock={item.lowStock} archived={archived} />
          </Pressable>
        );
      })}
      {items.moreFailure === undefined ? null : (
        <FailureNotice
          failure={items.moreFailure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadMoreItems();
          }}
          retryDisabled={items.loadingMore}
        />
      )}
      {items.nextCursor === null || items.phase !== "ready" ? null : (
        <Button
          label={items.loadingMore ? "Loading more…" : "Show more"}
          onPress={() => {
            void store.loadMoreItems();
          }}
          disabled={items.loadingMore}
          secondary
        />
      )}
    </View>
  );
}
