import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSessionStore } from "../auth/session-context";
import { useHardwareBack } from "../catalog/catalog-context";
import { newUuidV7 } from "../ids/uuidv7";
import { Button, Loading, styles } from "../onboarding/ui";
import { inventoryAffordances } from "./affordances";
import { type DocumentRef, DocumentScreen } from "./document-screen";
import { InventoryProvider, useInventory, useInventoryStore } from "./inventory-context";
import { type ItemLabel, InventoryStore } from "./inventory-store";
import { ItemDetailScreen } from "./item-detail-screen";
import { type StockDocumentKind, StockDocumentScreen } from "./stock-document-screen";
import { StockListScreen } from "./stock-list-screen";
import { StocktakeDetailScreen } from "./stocktake-detail-screen";
import { StocktakesScreen } from "./stocktakes-screen";

type InventoryTab = "stock" | "stocktakes";

type InventoryView =
  | { readonly kind: "list" }
  | { readonly kind: "item"; readonly variantId: string }
  | {
      readonly kind: "form";
      readonly form: StockDocumentKind;
      readonly item: ItemLabel | undefined;
      readonly back: InventoryView;
    }
  | { readonly kind: "document"; readonly document: DocumentRef; readonly back: InventoryView }
  | { readonly kind: "stocktakes" }
  | { readonly kind: "stocktake"; readonly stocktakeId: string };

const UNAVAILABLE = "This item is not available. It may have been removed, or you may no longer have access to it.";

/**
 * Inventory of the selected business (plan 004 Slice 7). One
 * `InventoryStore` lives as long as this section is mounted for one business;
 * it is created in an effect so a remount never reuses a disposed store.
 * Nothing is stored on the device.
 */
export function InventoryScreen({
  businessId,
  role,
}: {
  readonly businessId: string;
  readonly role: string | undefined;
}) {
  const session = useSessionStore();
  const [store, setStore] = useState<InventoryStore | undefined>(undefined);

  useEffect(() => {
    const created = new InventoryStore({ businessId, session, newIdempotencyKey: newUuidV7 });
    setStore(created);
    created.start();
    return () => {
      created.dispose();
    };
  }, [session, businessId]);

  if (store === undefined) return <Loading label="Loading inventory…" />;
  return (
    <InventoryProvider store={store} allowed={inventoryAffordances(role)}>
      <InventoryBody />
    </InventoryProvider>
  );
}

function InventoryBody() {
  const session = useSessionStore();
  const store = useInventoryStore();
  const { businessUnavailable } = useInventory();
  const [view, setView] = useState<InventoryView>({ kind: "list" });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const tab: InventoryTab = view.kind === "stocktakes" || view.kind === "stocktake" ? "stocktakes" : "stock";

  /** A resource NOT_FOUND returns to the list and refreshes it; it never changes the selected business. */
  const unavailable = useCallback(() => {
    setNotice(UNAVAILABLE);
    setView({ kind: "list" });
    void store.refreshItems();
  }, [store]);
  const stocktakeUnavailable = useCallback(() => {
    setNotice(undefined);
    setView({ kind: "stocktakes" });
    void store.refreshStocktakes();
  }, [store]);
  const open = useCallback((next: InventoryView) => {
    setNotice(undefined);
    setView(next);
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

  return (
    <View style={styles.screen}>
      <View style={styles.row} accessibilityRole="tablist" accessibilityLabel="Inventory sections">
        {(["stock", "stocktakes"] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityLabel={value === "stock" ? "Stock" : "Stocktakes"}
            accessibilityState={{ selected: tab === value }}
            onPress={() => {
              open(value === "stock" ? { kind: "list" } : { kind: "stocktakes" });
            }}
            style={[styles.button, tab === value ? styles.primary : styles.secondary]}
          >
            <Text style={tab === value ? styles.primaryText : styles.secondaryText}>
              {value === "stock" ? "Stock" : "Stocktakes"}
            </Text>
          </Pressable>
        ))}
      </View>
      {view.kind === "list" || view.kind === "stocktakes" ? null : (
        <BackOnHardware
          onBack={() => {
            open(backOf(view));
          }}
        />
      )}
      {renderView()}
    </View>
  );

  function renderView() {
    switch (view.kind) {
      case "list":
        return (
          <StockListScreen
            notice={notice}
            onOpen={(variantId) => {
              open({ kind: "item", variantId });
            }}
            onForm={(form) => {
              open({ kind: "form", form, item: undefined, back: { kind: "list" } });
            }}
          />
        );
      case "item": {
        const here: InventoryView = view;
        return (
          <ItemDetailScreen
            key={view.variantId}
            variantId={view.variantId}
            onBack={() => {
              open({ kind: "list" });
            }}
            onUnavailable={unavailable}
            onForm={(form, item) => {
              open({ kind: "form", form, item, back: here });
            }}
            onDocument={(document) => {
              open({ kind: "document", document, back: here });
            }}
            onStocktake={(stocktakeId) => {
              open({ kind: "stocktake", stocktakeId });
            }}
          />
        );
      }
      case "form": {
        const back = view.back;
        return (
          <StockDocumentScreen
            key={`${view.form}-${view.item?.variantId ?? ""}`}
            kind={view.form}
            initialItem={view.item}
            onCancel={() => {
              open(back);
            }}
            onSaved={(document) => {
              open({ kind: "document", document, back });
            }}
          />
        );
      }
      case "document": {
        const back = view.back;
        return (
          <DocumentScreen
            key={view.document.id}
            document={view.document}
            onBack={() => {
              open(back);
            }}
            onUnavailable={unavailable}
          />
        );
      }
      case "stocktakes":
        return (
          <StocktakesScreen
            onOpen={(stocktakeId) => {
              open({ kind: "stocktake", stocktakeId });
            }}
          />
        );
      case "stocktake":
        return (
          <StocktakeDetailScreen
            key={view.stocktakeId}
            stocktakeId={view.stocktakeId}
            onBack={() => {
              open({ kind: "stocktakes" });
            }}
            onUnavailable={stocktakeUnavailable}
          />
        );
    }
  }
}

function backOf(view: InventoryView): InventoryView {
  switch (view.kind) {
    case "form":
    case "document":
      return view.back;
    case "stocktake":
    case "stocktakes":
      return { kind: "stocktakes" };
    case "list":
    case "item":
      return { kind: "list" };
  }
}

/** Android hardware back while a detail or form is open goes to the previous inventory view. */
function BackOnHardware({ onBack }: { readonly onBack: () => void }) {
  useHardwareBack(onBack);
  return null;
}
