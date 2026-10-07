"use client";

import type { ProductResponse } from "@tali/shared";
import { useCallback, useState } from "react";
import type { CatalogAffordances } from "./affordances";
import { useCatalogStore } from "./catalog-context";
import { ProductDetail } from "./product-detail";
import { ProductForm } from "./product-form";
import { ProductList } from "./product-list";

type View =
  | { readonly kind: "list"; readonly focusProductId?: string }
  | { readonly kind: "create" }
  | { readonly kind: "detail"; readonly productId: string }
  | { readonly kind: "edit"; readonly product: ProductResponse };

const UNAVAILABLE = "This item is not available. It may have been removed, or you may no longer have access to it.";

/** Products: list, detail, create and edit, as in-memory view state (no route changes). */
export function ProductsView({ allowed }: { readonly allowed: CatalogAffordances }) {
  const catalog = useCatalogStore();
  const [view, setView] = useState<View>({ kind: "list" });
  const [notice, setNotice] = useState<string | undefined>(undefined);

  /** A resource NOT_FOUND returns to the list and refreshes it; only the list read can mark the business unavailable. */
  const unavailable = useCallback(() => {
    setNotice(UNAVAILABLE);
    setView({ kind: "list" });
    void catalog.refreshProducts();
  }, [catalog]);

  switch (view.kind) {
    case "list":
      return (
        <ProductList
          allowed={allowed}
          notice={notice}
          focusProductId={view.focusProductId}
          onOpen={(productId) => {
            setNotice(undefined);
            setView({ kind: "detail", productId });
          }}
          onCreate={() => {
            setNotice(undefined);
            setView({ kind: "create" });
          }}
        />
      );
    case "create":
      return (
        <ProductForm
          mode={{ kind: "create" }}
          allowed={allowed}
          onSaved={(product) => {
            setView({ kind: "detail", productId: product.id });
          }}
          onCancel={() => {
            setView({ kind: "list" });
          }}
          onUnavailable={unavailable}
        />
      );
    case "detail":
      return (
        <ProductDetail
          key={view.productId}
          productId={view.productId}
          allowed={allowed}
          onBack={() => {
            setView({ kind: "list", focusProductId: view.productId });
          }}
          onEdit={(product) => {
            setView({ kind: "edit", product });
          }}
          onUnavailable={unavailable}
        />
      );
    case "edit":
      return (
        <ProductForm
          mode={{ kind: "edit", product: view.product }}
          allowed={allowed}
          onSaved={(product) => {
            setView({ kind: "detail", productId: product.id });
          }}
          onCancel={() => {
            setView({ kind: "detail", productId: view.product.id });
          }}
          onUnavailable={unavailable}
        />
      );
  }
}
