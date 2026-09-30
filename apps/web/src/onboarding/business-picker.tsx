import { useState } from "react";
import { useSession, useSessionStore } from "../lib/auth/session-context";
import { CreateBusinessForm } from "./create-business-form";
import { FailureAlert } from "./failure-alert";
import { roleLabel } from "./role-label";
import { ScreenHeading } from "./screen-heading";

/**
 * The businesses `GET /v1/me/businesses` returned, and nothing else: there is
 * no way to enter a business ID. With none, the create form is shown instead.
 */
export function BusinessPicker() {
  const store = useSessionStore();
  const session = useSession();
  const [creating, setCreating] = useState(false);

  if (session.businesses.length === 0) {
    return <CreateBusinessForm heading="Create your first business" />;
  }
  if (creating) {
    return (
      <CreateBusinessForm
        heading="Create another business"
        onCancel={() => {
          setCreating(false);
        }}
      />
    );
  }

  const loadingMore = session.pending === "loadMoreBusinesses";
  const failure = session.error?.action === "loadBusinesses" ? session.error.failure : undefined;

  return (
    <section aria-labelledby="business-picker-heading" className="onboarding">
      <ScreenHeading id="business-picker-heading">Choose a business</ScreenHeading>
      <ul className="business-list">
        {session.businesses.map(({ business, membership }) => (
          <li key={business.id}>
            <button
              type="button"
              className="business-choice"
              onClick={() => {
                store.selectBusiness(business.id);
              }}
            >
              <span className="business-name">{business.name}</span>
              <span className="business-meta">
                {business.currencyCode} · {business.timeZone} · {roleLabel(membership.role)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {loadingMore ? <p role="status">Loading more businesses…</p> : null}
      {failure === undefined ? null : (
        <FailureAlert
          failure={failure}
          onRetry={() => {
            void store.loadMoreBusinesses();
          }}
        />
      )}
      <div className="actions">
        {session.businessesNextCursor === null ? null : (
          <button
            type="button"
            className="secondary"
            disabled={loadingMore}
            onClick={() => {
              void store.loadMoreBusinesses();
            }}
          >
            Show more businesses
          </button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setCreating(true);
          }}
        >
          Create another business
        </button>
      </div>
    </section>
  );
}
