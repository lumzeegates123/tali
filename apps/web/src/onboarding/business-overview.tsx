import { useEffect, useState } from "react";
import { CatalogSection } from "../catalog/catalog-section";
import { InventorySection } from "../inventory/inventory-section";
import type { BusinessOverview, ResourceResult } from "../lib/auth/session-store";
import { useSession, useSessionStore } from "../lib/auth/session-context";
import { FailureAlert } from "./failure-alert";
import { InvitationsPanel } from "./invitations-panel";
import { MembersList } from "./members-list";
import { roleLabel } from "./role-label";
import { LoadingState, ScreenHeading } from "./screen-heading";

type OverviewState =
  { readonly phase: "loading" } | { readonly phase: "done"; readonly result: ResourceResult<BusinessOverview> };

type BusinessSection = "overview" | "catalog" | "inventory";

const SECTION_LABEL: Readonly<Record<BusinessSection, string>> = {
  overview: "Overview",
  catalog: "Catalog",
  inventory: "Inventory",
};

/** The selected business: an Overview | Catalog | Inventory switch. Role-based visibility is UX only. */
export function BusinessOverviewScreen({ businessId }: { readonly businessId: string }) {
  const session = useSession();
  const [section, setSection] = useState<BusinessSection>("overview");
  const summary = session.businesses.find((item) => item.business.id === businessId);

  return (
    <>
      <nav aria-label="Business sections" className="section-nav">
        {(["overview", "catalog", "inventory"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={section === value ? undefined : "secondary"}
            aria-current={section === value ? "page" : undefined}
            onClick={() => {
              setSection(value);
            }}
          >
            {SECTION_LABEL[value]}
          </button>
        ))}
      </nav>
      {section === "overview" ? (
        <OverviewSection businessId={businessId} />
      ) : section === "catalog" ? (
        <CatalogSection businessId={businessId} role={summary?.membership.role} />
      ) : (
        <InventorySection businessId={businessId} role={summary?.membership.role} />
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
