import type { ProductResponse } from "@tali/shared";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useSessionStore } from "../auth/session-context";
import { newUuidV7 } from "../ids/uuidv7";
import { Button, Loading, styles } from "../onboarding/ui";
import { catalogAffordances, type CatalogAffordances } from "./affordances";
import { CatalogProvider, useCatalog, useCatalogStore } from "./catalog-context";
import { CatalogStore } from "./catalog-store";
import { ProductDetailScreen } from "./product-detail-screen";
import { ProductFormScreen } from "./product-form-screen";
import { ProductListScreen } from "./product-list-screen";

type CatalogView =
  | { readonly kind: "list" }
  | { readonly kind: "create" }
  | { readonly kind: "detail"; readonly productId: string }
  | { readonly kind: "edit"; readonly product: ProductResponse };

const UNAVAILABLE = "This item is not available. It may have been removed, or you may no longer have access to it.";

/**
 * The catalog of the selected business. One `CatalogStore` lives as long as
 * this section is mounted for one business; it is created in an effect so a
 * remount never reuses a disposed store.
 */
export function CatalogScreen({
  businessId,
  role,
}: {
  readonly businessId: string;
  readonly role: string | undefined;
}) {
  const session = useSessionStore();
  const [store, setStore] = useState<CatalogStore | undefined>(undefined);

  useEffect(() => {
    const created = new CatalogStore({ businessId, session, newIdempotencyKey: newUuidV7 });
    setStore(created);
    created.start();
    return () => {
      created.dispose();
    };
  }, [session, businessId]);

  if (store === undefined) return <Loading label="Loading the catalog…" />;
  return (
    <CatalogProvider store={store}>
      <CatalogBody allowed={catalogAffordances(role)} />
    </CatalogProvider>
  );
}

function CatalogBody({ allowed }: { readonly allowed: CatalogAffordances }) {
  const session = useSessionStore();
  const catalog = useCatalogStore();
  const { businessUnavailable } = useCatalog();
  const [view, setView] = useState<CatalogView>({ kind: "list" });
  const [notice, setNotice] = useState<string | undefined>(undefined);

  /** A resource NOT_FOUND returns to the list and refreshes it; it never changes the selected business. */
  const unavailable = useCallback(() => {
    setNotice(UNAVAILABLE);
    setView({ kind: "list" });
    void catalog.refreshProducts();
  }, [catalog]);
  const toList = useCallback(() => {
    setView({ kind: "list" });
  }, []);

  if (businessUnavailable) {
    return (
      <View style={styles.alert} accessibilityRole="alert">
        <Text>This business is no longer available to you.</Text>
        <Button
          label="Switch business"
          onPress={() => {
            session.changeBusiness();
          }}
        />
      </View>
    );
  }

  switch (view.kind) {
    case "list":
      return (
        <ProductListScreen
          allowed={allowed}
          notice={notice}
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
        <ProductFormScreen
          mode={{ kind: "create" }}
          allowed={allowed}
          onSaved={(product) => {
            setView({ kind: "detail", productId: product.id });
          }}
          onCancel={toList}
          onUnavailable={unavailable}
        />
      );
    case "detail":
      return (
        <ProductDetailScreen
          key={view.productId}
          productId={view.productId}
          allowed={allowed}
          onBack={toList}
          onEdit={(product) => {
            setView({ kind: "edit", product });
          }}
          onUnavailable={unavailable}
        />
      );
    case "edit": {
      const productId = view.product.id;
      return (
        <ProductFormScreen
          mode={{ kind: "edit", product: view.product }}
          allowed={allowed}
          onSaved={(product) => {
            setView({ kind: "detail", productId: product.id });
          }}
          onCancel={() => {
            setView({ kind: "detail", productId });
          }}
          onUnavailable={unavailable}
        />
      );
    }
  }
}
