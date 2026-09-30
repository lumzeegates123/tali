import type { MembersResponse } from "@tali/shared";
import { useCallback, useEffect, useState } from "react";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { useSessionStore } from "../lib/auth/session-context";
import { FailureAlert } from "./failure-alert";
import { roleLabel } from "./role-label";

type Member = MembersResponse["items"][number];

type Failure = ApiFailure | { readonly kind: "missing-default-location" };

type MembersState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly items: readonly Member[]; readonly nextCursor: string | null }
  | { readonly phase: "denied" }
  | { readonly phase: "failed"; readonly failure: Failure };

/**
 * Read-only `GET /v1/businesses/:id/members`. The server decides who may see
 * it (`member:read`); PERMISSION_DENIED is shown as "not available", never as
 * an empty list. Role and suspension changes are API-only in Build 1.
 */
export function MembersList({ businessId }: { readonly businessId: string }) {
  const store = useSessionStore();
  const [state, setState] = useState<MembersState>({ phase: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailure, setMoreFailure] = useState<Failure | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ phase: "loading" });
    void store.loadMembers(businessId).then((result) => {
      if (!active) return;
      if (result.ok) setState({ phase: "ready", items: result.value.items, nextCursor: result.value.nextCursor });
      else if (result.failure.kind === "api-error" && result.failure.code === "PERMISSION_DENIED") {
        setState({ phase: "denied" });
      } else setState({ phase: "failed", failure: result.failure });
    });
    return () => {
      active = false;
    };
  }, [store, businessId, attempt]);

  const loadMore = useCallback(() => {
    if (state.phase !== "ready" || state.nextCursor === null) return;
    setLoadingMore(true);
    setMoreFailure(undefined);
    void store.loadMembers(businessId, { after: state.nextCursor }).then((result) => {
      setLoadingMore(false);
      if (result.ok) {
        setState({
          phase: "ready",
          items: [...state.items, ...result.value.items],
          nextCursor: result.value.nextCursor,
        });
      } else {
        setMoreFailure(result.failure);
      }
    });
  }, [store, businessId, state]);

  return (
    <section aria-labelledby="members-heading" className="onboarding">
      <h2 id="members-heading">Members</h2>
      {state.phase === "loading" ? (
        <p role="status" aria-live="polite">
          Loading members…
        </p>
      ) : null}
      {state.phase === "denied" ? (
        <p data-testid="members-not-available">The members list is not available with your access.</p>
      ) : null}
      {state.phase === "failed" ? (
        <FailureAlert
          failure={state.failure}
          onRetry={() => {
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
      {state.phase === "ready" ? (
        state.items.length === 0 ? (
          <p>No members to show.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((member) => (
                  <tr key={member.id}>
                    <td>{member.displayName}</td>
                    <td>{roleLabel(member.role)}</td>
                    <td>{member.status === "ACTIVE" ? "Active" : "Suspended"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {moreFailure === undefined ? null : <FailureAlert failure={moreFailure} onRetry={loadMore} />}
            {state.nextCursor === null ? null : (
              <button type="button" className="secondary" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading more members…" : "Show more members"}
              </button>
            )}
          </>
        )
      ) : null}
    </section>
  );
}
