import type { ProductResponse } from "@tali/shared";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ApiFailure } from "../api/tali-api-client";
import { Button, FailureNotice, Heading, Loading, styles } from "../onboarding/ui";
import type { CatalogAffordances } from "./affordances";
import { useCatalog, useCatalogStore, useHardwareBack } from "./catalog-context";
import { formatMoney } from "./money-format";
import { PriceForm } from "./price-form";

type DetailState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly product: ProductResponse }
  | { readonly phase: "failed"; readonly failure: ApiFailure };

function isCode(failure: ApiFailure | undefined, code: string): boolean {
  return failure?.kind === "api-error" && failure.code === code;
}

/** One product. Categories are read-only on mobile; every action is re-checked by the API. */
export function ProductDetailScreen({
  productId,
  allowed,
  onBack,
  onEdit,
  onUnavailable,
}: {
  readonly productId: string;
  readonly allowed: CatalogAffordances;
  readonly onBack: () => void;
  readonly onEdit: (product: ProductResponse) => void;
  readonly onUnavailable: () => void;
}) {
  const store = useCatalogStore();
  const { reference, categoryOptions } = useCatalog();
  const [state, setState] = useState<DetailState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [statusFailure, setStatusFailure] = useState<ApiFailure | undefined>(undefined);
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const [outsideCategory, setOutsideCategory] = useState<string | undefined>(undefined);
  useHardwareBack(onBack);

  useEffect(() => {
    let active = true;
    setState({ phase: "loading" });
    void store.getProduct(productId).then((outcome) => {
      if (!active || outcome.status === "ignored") return;
      if (outcome.status === "failed" && isCode(outcome.failure, "NOT_FOUND")) {
        onUnavailable();
        return;
      }
      setState(
        outcome.status === "ok"
          ? { phase: "ready", product: outcome.value }
          : { phase: "failed", failure: outcome.failure },
      );
    });
    return () => {
      active = false;
    };
  }, [store, productId, attempt, onUnavailable]);

  const product = state.phase === "ready" ? state.product : undefined;
  const categoryId = product?.categoryId ?? null;
  const listedCategory = categoryOptions.items.find((item) => item.id === categoryId);
  const needsLookup = categoryId !== null && listedCategory === undefined && categoryOptions.phase !== "loading";

  useEffect(() => {
    if (!needsLookup) return;
    let active = true;
    void store.getCategory(categoryId).then((outcome) => {
      if (active && outcome.status === "ok") {
        setOutsideCategory(
          outcome.value.status === "ARCHIVED" ? `${outcome.value.name} (archived)` : outcome.value.name,
        );
      }
    });
    return () => {
      active = false;
    };
  }, [store, categoryId, needsLookup]);

  function changeStatus(current: ProductResponse) {
    setBusy(true);
    setStatusFailure(undefined);
    setSaved(undefined);
    const request =
      current.status === "ACTIVE"
        ? store.archiveProduct(current.id, { expectedVersion: current.version })
        : store.reactivateProduct(current.id, { expectedVersion: current.version });
    void request.then((outcome) => {
      setBusy(false);
      if (outcome.status === "ok") {
        setState({ phase: "ready", product: outcome.value });
        setSaved(outcome.value.status === "ARCHIVED" ? "Product archived." : "Product reactivated.");
      } else if (outcome.status === "failed") {
        if (isCode(outcome.failure, "NOT_FOUND")) onUnavailable();
        else setStatusFailure(outcome.failure);
      }
    });
  }

  const categoryLabel =
    categoryId === null
      ? "None"
      : (listedCategory?.name ??
        outsideCategory ??
        (categoryOptions.phase === "loading" ? "Loading…" : "Not available"));

  return (
    <View style={styles.screen}>
      <Button label="Back to products" onPress={onBack} secondary />
      {state.phase === "loading" ? (
        <>
          <Heading>Product</Heading>
          <Loading label="Loading the product…" />
        </>
      ) : state.phase === "failed" ? (
        <>
          <Heading>Product</Heading>
          <FailureNotice
            failure={state.failure}
            notFoundScope="resource"
            onRetry={() => {
              setAttempt((value) => value + 1);
            }}
          />
        </>
      ) : (
        <>
          <Heading>{state.product.name}</Heading>
          {saved === undefined ? null : <Text accessibilityLiveRegion="polite">{saved}</Text>}
          <Text>Status: {state.product.status === "ACTIVE" ? "Active" : "Archived"}</Text>
          <Text>Description: {state.product.description ?? "None"}</Text>
          <Text>Category: {categoryLabel}</Text>
          <Text>SKU: {state.product.sku ?? "None"}</Text>
          <Text>Barcode: {state.product.barcode ?? "None"}</Text>
          <Text>Stock unit: {state.product.stockUnit}</Text>
          <Text>Track inventory: {state.product.trackInventory ? "Yes" : "No"}</Text>
          <Text testID="product-price">
            Selling price:{" "}
            {state.product.sellingPrice === null
              ? "Not set"
              : formatMoney(state.product.sellingPrice, reference.currency)}
          </Text>
          {allowed.canManage ? (
            <View style={styles.row}>
              <Button
                label="Edit product"
                onPress={() => {
                  onEdit(state.product);
                }}
              />
              <Button
                label={state.product.status === "ACTIVE" ? "Archive product" : "Reactivate product"}
                onPress={() => {
                  changeStatus(state.product);
                }}
                disabled={busy}
                secondary
              />
            </View>
          ) : null}
          {statusFailure === undefined ? null : <FailureNotice failure={statusFailure} notFoundScope="resource" />}
          {isCode(statusFailure, "VERSION_CONFLICT") ? (
            <Button
              label="Reload latest"
              onPress={() => {
                setStatusFailure(undefined);
                setAttempt((value) => value + 1);
              }}
            />
          ) : null}
          {allowed.canPrice ? (
            <PriceForm
              product={state.product}
              onChanged={(next) => {
                setState({ phase: "ready", product: next });
                setSaved("Price saved.");
              }}
              onReload={() => {
                setAttempt((value) => value + 1);
              }}
              onUnavailable={onUnavailable}
            />
          ) : null}
        </>
      )}
    </View>
  );
}
