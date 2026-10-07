"use client";

import { useEffect, useState } from "react";
import { useSessionStore } from "../lib/auth/session-context";
import { newUuidV7 } from "../lib/ids/uuidv7";
import { LoadingState } from "../onboarding/screen-heading";
import { catalogAffordances } from "./affordances";
import { CatalogProvider, useCatalog } from "./catalog-context";
import { CatalogStore } from "./catalog-store";
import { CategoriesPanel } from "./categories-panel";
import { ProductsView } from "./products-view";

type CatalogTab = "products" | "categories";

/**
 * The catalog of the selected business. One `CatalogStore` lives as long as
 * this section is mounted for one business; it is created in an effect so a
 * remount (including React's development double mount) never reuses a
 * disposed store.
 */
export function CatalogSection({
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

  return (
    <section aria-labelledby="catalog-heading" className="onboarding catalog">
      <h2 id="catalog-heading">Catalog</h2>
      {store === undefined ? (
        <LoadingState label="Loading the catalog…" />
      ) : (
        <CatalogProvider store={store}>
          <CatalogBody role={role} />
        </CatalogProvider>
      )}
    </section>
  );
}

function CatalogBody({ role }: { readonly role: string | undefined }) {
  const session = useSessionStore();
  const catalog = useCatalog();
  const [tab, setTab] = useState<CatalogTab>("products");
  const allowed = catalogAffordances(role);

  if (catalog.businessUnavailable) {
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
      <nav aria-label="Catalog sections" className="section-nav">
        {(["products", "categories"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={tab === value ? undefined : "secondary"}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => {
              setTab(value);
            }}
          >
            {value === "products" ? "Products" : "Categories"}
          </button>
        ))}
      </nav>
      {tab === "products" ? <ProductsView allowed={allowed} /> : <CategoriesPanel allowed={allowed} />}
    </>
  );
}
