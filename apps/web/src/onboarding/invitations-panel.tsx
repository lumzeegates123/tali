import type { InvitationResponse } from "@tali/shared";
import { InvitableRoleWireSchema } from "@tali/shared";
import type { SyntheticEvent } from "react";
import { useState } from "react";
import type { ApiFailure, InvitableRole } from "../lib/api-client/tali-api-client";
import { useSessionStore } from "../lib/auth/session-context";
import { invitationLink } from "../lib/invitations/invitation-link";
import { FailureAlert } from "./failure-alert";
import { roleLabel } from "./role-label";

/** The one-time link, held in this component's memory only until dismissed or the screen is left. */
interface ShownLink {
  readonly invitationId: string;
  readonly url: string;
}

const STATUS_TEXT: Record<InvitationResponse["status"], string> = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  REVOKED: "Revoked",
};

/**
 * Invite a person to the business (`member:invite`) and revoke invitations
 * created on this screen. The server decides who may do this; this panel is
 * only offered to owners for convenience. The invitation link contains a
 * one-time secret: it is shown once, never stored, and replays cannot show it
 * again. Build 1 has no invitation list endpoint, so only invitations created
 * here are listed.
 */
export function InvitationsPanel({ businessId }: { readonly businessId: string }) {
  const store = useSessionStore();
  const [role, setRole] = useState<InvitableRole>("CASHIER");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const [shown, setShown] = useState<ShownLink | undefined>(undefined);
  const [alreadyShown, setAlreadyShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [invitations, setInvitations] = useState<readonly InvitationResponse[]>([]);
  const [revokeFailure, setRevokeFailure] = useState<ApiFailure | undefined>(undefined);

  function remember(invitation: InvitationResponse) {
    setInvitations((items) => [invitation, ...items.filter((item) => item.id !== invitation.id)]);
  }

  function create(event?: SyntheticEvent<HTMLFormElement>) {
    event?.preventDefault();
    setSubmitting(true);
    setFailure(undefined);
    setAlreadyShown(false);
    setCopied(false);
    setShown(undefined);
    void store.createInvitation(businessId, role).then((outcome) => {
      setSubmitting(false);
      if (outcome.status === "created") {
        remember(outcome.invitation);
        setShown({ invitationId: outcome.invitation.id, url: invitationLink(window.location.origin, outcome.token) });
      } else if (outcome.status === "alreadyShown") {
        remember(outcome.invitation);
        setAlreadyShown(true);
      } else if (outcome.status === "failed") {
        setFailure(outcome.failure);
      }
    });
  }

  function revoke(invitationId: string) {
    setRevokeFailure(undefined);
    void store.revokeInvitation(businessId, invitationId).then((outcome) => {
      if (outcome.status === "revoked") {
        remember(outcome.invitation);
        if (shown?.invitationId === invitationId) setShown(undefined);
      } else if (outcome.status === "failed") {
        setRevokeFailure(outcome.failure);
      }
    });
  }

  function copy(url: string) {
    void navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  }

  return (
    <section aria-labelledby="invitations-heading" className="onboarding">
      <h2 id="invitations-heading">Invite someone</h2>
      <form onSubmit={create} noValidate aria-busy={submitting}>
        <div className="field">
          <label htmlFor="invitation-role">Role</label>
          <select
            id="invitation-role"
            value={role}
            disabled={submitting}
            onChange={(event) => {
              setRole(InvitableRoleWireSchema.parse(event.target.value));
            }}
          >
            {InvitableRoleWireSchema.options.map((option) => (
              <option key={option} value={option}>
                {roleLabel(option)}
              </option>
            ))}
          </select>
          <p className="hint">The invitation expires after 72 hours and can be used by one person only.</p>
        </div>
        {failure === undefined ? null : (
          <FailureAlert failure={failure} onRetry={create} retryLabel="Try again" retryDisabled={submitting} />
        )}
        <div className="actions">
          <button type="submit" disabled={submitting}>
            {submitting ? "Creating invitation…" : "Create invitation link"}
          </button>
        </div>
      </form>
      {shown === undefined ? null : (
        <div className="notice" data-testid="invitation-link-panel">
          <p>
            <strong>This link is shown once.</strong> Copy it now and send it to the person you are inviting. Tali
            cannot show it again; if it is lost, revoke the invitation and create a new one.
          </p>
          <div className="field">
            <label htmlFor="invitation-link">Invitation link</label>
            <input
              id="invitation-link"
              readOnly
              value={shown.url}
              autoComplete="off"
              spellCheck={false}
              onFocus={(event) => {
                event.target.select();
              }}
            />
          </div>
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                copy(shown.url);
              }}
            >
              Copy link
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setShown(undefined);
                setCopied(false);
              }}
            >
              Done
            </button>
          </div>
          {copied ? <p role="status">Link copied.</p> : null}
        </div>
      )}
      {alreadyShown ? (
        <p role="status" className="notice">
          This invitation was already created, and its link cannot be shown again. Revoke it and create a new one.
        </p>
      ) : null}
      {invitations.length === 0 ? null : (
        <>
          <h3>Invitations created here</h3>
          {revokeFailure === undefined ? null : <FailureAlert failure={revokeFailure} />}
          <table>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((invitation) => (
                <tr key={invitation.id}>
                  <td>{roleLabel(invitation.role)}</td>
                  <td>{STATUS_TEXT[invitation.status]}</td>
                  <td>
                    {invitation.status === "PENDING" ? (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          revoke(invitation.id);
                        }}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
