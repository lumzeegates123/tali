"use client";

import { useCallback, useEffect, useState } from "react";
import { useSessionStore } from "../lib/auth/session-context";
import { newUuidV7 } from "../lib/ids/uuidv7";
import { LoadingState } from "../onboarding/screen-heading";
import { salesAffordances } from "./affordances";
import { SaleDetail, SalesHistory } from "./sales-history";
import { SalesProvider, useSales, useSalesAllowed } from "./sales-context";
import { SalesStore } from "./sales-store";
import { SellView } from "./sell-view";

type SalesView =
  { readonly kind: "sell" } | { readonly kind: "history" } | { readonly kind: "sale"; readonly saleId: string };

const UNAVAILABLE = "This sale is not available. It may not exist, or you may not have access to it.";

/**
 * Sales of the selected business (plan 005 Slice 7). One `SalesStore` lives
 * as long as this section is mounted for one business; it is created in an
 * effect so a remount never reuses a disposed store, and disposing it drops
 * the cart, tenders and every idempotency key.
 */
export function SalesSection({ businessId, role }: { readonly businessId: string; readonly role: string | undefined }) {
  const session = useSessionStore();
  const [store, setStore] = useState<SalesStore | undefined>(undefined);

  useEffect(() => {
    const created = new SalesStore({ businessId, session, newIdempotencyKey: newUuidV7 });
    setStore(created);
    created.start();
    return () => {
      created.dispose();
    };
  }, [session, businessId]);

  return (
    <section aria-labelledby="sales-heading" className="onboarding sales">
      <h2 id="sales-heading">Sales</h2>
      {store === undefined ? (
        <LoadingState label="Loading sales…" />
      ) : (
        <SalesProvider store={store} allowed={salesAffordances(role)}>
          <SalesBody />
        </SalesProvider>
      )}
    </section>
  );
}

function SalesBody() {
  const session = useSessionStore();
  const allowed = useSalesAllowed();
  const { businessUnavailable } = useSales();
  const [view, setView] = useState<SalesView>(allowed.create ? { kind: "sell" } : { kind: "history" });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const tab = view.kind === "sell" ? "sell" : "history";

  const unavailable = useCallback(() => {
    setNotice(UNAVAILABLE);
    setView({ kind: "history" });
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

  const tabs = allowed.create ? (["sell", "history"] as const) : (["history"] as const);

  return (
    <>
      <nav aria-label="Sales sections" className="section-nav">
        {tabs.map((value) => (
          <button
            key={value}
            type="button"
            className={tab === value ? undefined : "secondary"}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => {
              setNotice(undefined);
              setView(value === "sell" ? { kind: "sell" } : { kind: "history" });
            }}
          >
            {value === "sell" ? "Sell" : "Sales"}
          </button>
        ))}
      </nav>
      {notice === undefined ? null : (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {view.kind === "sell" && allowed.create ? (
        <SellView
          onCheckHistory={() => {
            setView({ kind: "history" });
          }}
        />
      ) : view.kind === "sale" ? (
        <SaleDetail
          key={view.saleId}
          saleId={view.saleId}
          onBack={() => {
            setView({ kind: "history" });
          }}
          onUnavailable={unavailable}
        />
      ) : (
        <SalesHistory
          onOpen={(saleId) => {
            setNotice(undefined);
            setView({ kind: "sale", saleId });
          }}
        />
      )}
    </>
  );
}
