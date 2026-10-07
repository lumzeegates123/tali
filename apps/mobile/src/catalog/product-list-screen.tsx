import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button, FailureNotice, Field, Heading, Loading, styles } from "../onboarding/ui";
import type { CatalogAffordances } from "./affordances";
import { Choice, useCatalog, useCatalogStore } from "./catalog-context";
import type { CatalogStatus } from "./catalog-store";
import { formatMoney } from "./money-format";

const STATUS_LABEL: Record<CatalogStatus, string> = { ACTIVE: "Active", ARCHIVED: "Archived" };

/** Server-side search (name, SKU or barcode typed or pasted) with an ACTIVE/ARCHIVED filter and Show more. */
export function ProductListScreen({
  allowed,
  notice,
  onOpen,
  onCreate,
}: {
  readonly allowed: CatalogAffordances;
  readonly notice: string | undefined;
  readonly onOpen: (productId: string) => void;
  readonly onCreate: () => void;
}) {
  const store = useCatalogStore();
  const { products, reference } = useCatalog();
  const [draft, setDraft] = useState(products.query);

  function search() {
    void store.searchProducts(draft, products.status);
  }

  return (
    <View style={styles.screen}>
      <Heading>Products</Heading>
      {notice === undefined ? null : (
        <View style={styles.notice} accessibilityLiveRegion="polite">
          <Text>{notice}</Text>
        </View>
      )}
      <Field label="Search name, SKU or barcode" value={draft} onChangeText={setDraft} />
      <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="Status">
        {(["ACTIVE", "ARCHIVED"] as const).map((status) => (
          <Choice
            key={status}
            label={STATUS_LABEL[status]}
            selected={products.status === status}
            onPress={() => {
              void store.searchProducts(products.query, status);
            }}
          />
        ))}
      </View>
      <View style={styles.row}>
        <Button label="Search" onPress={search} />
        {allowed.canManage ? <Button label="Create product" onPress={onCreate} secondary /> : null}
      </View>
      {products.phase === "loading" ? <Loading label="Loading products…" /> : null}
      {products.phase === "failed" && products.failure !== undefined ? (
        <FailureNotice
          failure={products.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.refreshProducts();
          }}
        />
      ) : null}
      {products.phase === "ready" && products.items.length === 0 ? (
        <Text>{products.query === "" ? "No products yet." : "No products match this search."}</Text>
      ) : null}
      {products.items.map((product) => (
        <Pressable
          key={product.id}
          accessibilityRole="button"
          accessibilityLabel={`Open ${product.name}`}
          onPress={() => {
            onOpen(product.id);
          }}
          style={styles.card}
        >
          <Text style={styles.strong}>{product.name}</Text>
          <Text>
            SKU: {product.sku ?? "None"} · Barcode: {product.barcode ?? "None"}
          </Text>
          <Text>
            Price: {product.sellingPrice === null ? "Not set" : formatMoney(product.sellingPrice, reference.currency)} ·{" "}
            {STATUS_LABEL[product.status]}
          </Text>
        </Pressable>
      ))}
      {products.moreFailure === undefined ? null : (
        <FailureNotice
          failure={products.moreFailure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadMoreProducts();
          }}
          retryDisabled={products.loadingMore}
        />
      )}
      {products.nextCursor === null || products.phase !== "ready" ? null : (
        <Button
          label={products.loadingMore ? "Loading more…" : "Show more"}
          onPress={() => {
            void store.loadMoreProducts();
          }}
          disabled={products.loadingMore}
          secondary
        />
      )}
    </View>
  );
}
