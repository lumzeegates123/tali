"use client";

import { useCallback, useEffect, useState } from "react";
import { useSessionStore } from "../lib/auth/session-context";
import { newUuidV7 } from "../lib/ids/uuidv7";
import { LoadingState } from "../onboarding/screen-heading";
import { inventoryAffordances } from "./affordances";
import { DocumentView, type DocumentRef } from "./document-view";
import { InventoryProvider, useInventory, useInventoryStore } from "./inventory-context";
import { type ItemLabel, InventoryStore } from "./inventory-store";
import { ItemDetail } from "./item-detail";
import { type StockDocumentKind, StockDocumentForm } from "./stock-document-form";
import { StockList } from "./stock-list";
import { StocktakeDetail } from "./stocktake-detail";
import { StocktakesView } from "./stocktakes-view";

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
 */
export function InventorySection({
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

  return (
    <section aria-labelledby="inventory-heading" className="onboarding inventory">
      <h2 id="inventory-heading">Inventory</h2>
      {store === undefined ? (
        <LoadingState label="Loading inventory…" />
      ) : (
        <InventoryProvider store={store} allowed={inventoryAffordances(role)}>
          <InventoryBody />
        </InventoryProvider>
      )}
    </section>
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
      <div role="alert" className="alert">
        <p>This business is no longer available to you.</p>
        <button
          type="button"
          onClick={() => {
            session.changeBusiness();
          }}
        >
          Switch business
        </button>
      </div>
    );
  }

  return (
    <>
      <nav aria-label="Inventory sections" className="section-nav">
        {(["stock", "stocktakes"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={tab === value ? undefined : "secondary"}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => {
              open(value === "stock" ? { kind: "list" } : { kind: "stocktakes" });
            }}
          >
            {value === "stock" ? "Stock" : "Stocktakes"}
          </button>
        ))}
      </nav>
      {renderView()}
    </>
  );

  function renderView() {
    switch (view.kind) {
      case "list":
        return (
          <StockList
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
          <ItemDetail
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
          <StockDocumentForm
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
          <DocumentView
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
          <StocktakesView
            onOpen={(stocktakeId) => {
              open({ kind: "stocktake", stocktakeId });
            }}
          />
        );
      case "stocktake":
        return (
          <StocktakeDetail
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
