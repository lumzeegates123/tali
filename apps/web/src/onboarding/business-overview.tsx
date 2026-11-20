import { useEffect, useState } from "react";
import { CatalogSection } from "../catalog/catalog-section";
import { InventorySection } from "../inventory/inventory-section";
import { LedgerSection } from "../ledger/ledger-section";
import { salesAffordances } from "../sales/affordances";
import { SalesSection } from "../sales/sales-section";
import type { BusinessOverview, ResourceResult } from "../lib/auth/session-store";
import { useSession, useSessionStore } from "../lib/auth/session-context";
import { FailureAlert } from "./failure-alert";
import { InvitationsPanel } from "./invitations-panel";
import { MembersList } from "./members-list";
import { roleLabel } from "./role-label";
import { LoadingState, ScreenHeading } from "./screen-heading";

type OverviewState =
  { readonly phase: "loading" } | { readonly phase: "done"; readonly result: ResourceResult<BusinessOverview> };

type BusinessSection = "overview" | "catalog" | "inventory" | "sales" | "ledger";

const SECTION_LABEL: Readonly<Record<BusinessSection, string>> = {
  overview: "Overview",
  catalog: "Catalog",
  inventory: "Inventory",
  sales: "Sales",
  ledger: "Ledger",
};

/**
 * The selected business: Overview | Catalog | Inventory, plus Sales and
 * Ledger for the roles that may use them. Role-based visibility is UX only;
 * the API checks every request.
 */
export function BusinessOverviewScreen({ businessId }: { readonly businessId: string }) {
  const session = useSession();
  const [section, setSection] = useState<BusinessSection>("overview");
  const summary = session.businesses.find((item) => item.business.id === businessId);
  const role = summary?.membership.role;
  const sales = salesAffordances(role);
  const sections: readonly BusinessSection[] = [
    "overview",
    "catalog",
    "inventory",
    ...(sales.salesVisible ? (["sales"] as const) : []),
    ...(sales.ledger ? (["ledger"] as const) : []),
  ];
  const shown = sections.includes(section) ? section : "overview";

  return (
    <>
      <nav aria-label="Business sections" className="section-nav">
        {sections.map((value) => (
          <button
            key={value}
            type="button"
            className={shown === value ? undefined : "secondary"}
            aria-current={shown === value ? "page" : undefined}
            onClick={() => {
              setSection(value);
            }}
          >
            {SECTION_LABEL[value]}
          </button>
        ))}
      </nav>
      {shown === "overview" ? (
        <OverviewSection businessId={businessId} />
      ) : shown === "catalog" ? (
        <CatalogSection businessId={businessId} role={role} />
      ) : shown === "inventory" ? (
        <InventorySection businessId={businessId} role={role} />
      ) : shown === "sales" ? (
        <SalesSection businessId={businessId} role={role} />
      ) : (
        <LedgerSection businessId={businessId} />
      )}
    </>
  );
}

/**
 * The selected business, loaded from the API every time it is selected:
 * name, currency, time zone and the active default location. No metrics.
 */
function OverviewSection({ businessId }: { readonly businessId: string }) {
  const store = useSessionStore();
  const session = useSession();
  const [state, setState] = useState<OverviewState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const summary = session.businesses.find((item) => item.business.id === businessId);

  useEffect(() => {
    let active = true;
    setState({ phase: "loading" });
    void store.loadBusinessOverview(businessId).then((result) => {
      if (active) setState({ phase: "done", result });
    });
    return () => {
      active = false;
    };
  }, [store, businessId, attempt]);

  return (
    <>
      <section aria-labelledby="overview-heading" className="onboarding">
        {state.phase === "loading" ? (
          <>
            <ScreenHeading id="overview-heading">Business overview</ScreenHeading>
            <LoadingState label="Loading the business…" />
          </>
        ) : state.result.ok ? (
          <>
            <ScreenHeading id="overview-heading">{state.result.value.business.name}</ScreenHeading>
            <dl>
              <dt>Currency</dt>
              <dd>{state.result.value.business.currencyCode}</dd>
              <dt>Time zone</dt>
              <dd>{state.result.value.business.timeZone}</dd>
              <dt>Default location</dt>
              <dd>{state.result.value.defaultLocation.name}</dd>
              {summary === undefined ? null : (
                <>
                  <dt>Your role</dt>
                  <dd>{roleLabel(summary.membership.role)}</dd>
                </>
              )}
            </dl>
          </>
        ) : (
          <>
            <ScreenHeading id="overview-heading">Business overview</ScreenHeading>
            <FailureAlert
              failure={state.result.failure}
              onRetry={() => {
                setAttempt((value) => value + 1);
              }}
            />
          </>
        )}
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              store.changeBusiness();
            }}
          >
            Switch business
          </button>
        </div>
      </section>
      {state.phase === "done" && state.result.ok ? <MembersList businessId={businessId} /> : null}
      {state.phase === "done" && state.result.ok && summary?.membership.role === "OWNER" ? (
        <InvitationsPanel businessId={businessId} />
      ) : null}
    </>
  );
}
