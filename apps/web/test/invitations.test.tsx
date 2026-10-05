import type { WebPublicConfig } from "@tali/config/public";
import { isUuidV7 } from "@tali/domain/kernel";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/lib/api-client/tali-api-client";
import { SessionStore } from "../src/lib/auth/session-store";
import { newUuidV7 } from "../src/lib/ids/uuidv7";
import { invitationLink, takeInvitationToken } from "../src/lib/invitations/invitation-link";
import { OnboardingApp } from "../src/onboarding/onboarding-app";
import {
  apiError,
  BUSINESS_A,
  BUSINESS_B,
  type FakeTaliApi,
  json,
  MEMBERSHIP_A,
  networkError,
  registeredUserApi,
  settle,
} from "./support/fake-tali-api";

const LOCAL: WebPublicConfig = { env: "local", apiBaseUrl: "http://api.test", authMode: "local" };
/** Synthetic, low-entropy stand-in for a one-time invitation token. */
const INVITATION_TOKEN = `tali_inv_${"x".repeat(43)}`;
const INVITATION = {
  id: "0191a1b2-0000-7000-8000-0000000000c1",
  role: "CASHIER",
  status: "PENDING",
  expiresAt: "2026-10-03T10:00:00.000Z",
};
const INVITATIONS_PATH = `/v1/businesses/${BUSINESS_A.id}/invitations`;
const ACCEPT_ROUTE = "POST /v1/invitations/accept";

function storeFor(api: FakeTaliApi): SessionStore {
  const client = new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch: api.fetch });
  return new SessionStore({ api: client, newIdempotencyKey: newUuidV7 });
}

async function ownerWithBusinessSelected(api: FakeTaliApi): Promise<SessionStore> {
  const store = storeFor(api);
  await store.signInLocal("local-user-ada");
  store.selectBusiness(BUSINESS_A.id);
  return store;
}

function acceptedBody() {
  return {
    business: BUSINESS_B,
    membership: { id: "0191a1b2-0000-7000-8000-0000000000b2", role: "CASHIER", status: "ACTIVE" },
  };
}

function expectNothingPersisted() {
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(document.cookie).toBe("");
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("invitation links", () => {
  it("builds the accept link from the browser origin with the token in the fragment", () => {
    expect(invitationLink("http://127.0.0.1:3911", INVITATION_TOKEN)).toBe(
      `http://127.0.0.1:3911/invitations/accept#token=${INVITATION_TOKEN}`,
    );
  });

  it("takes the token from the fragment and strips the fragment from the URL", () => {
    window.history.replaceState({ kept: true }, "", `/invitations/accept?x=1#token=${INVITATION_TOKEN}`);
    expect(takeInvitationToken(window.location, window.history)).toBe(INVITATION_TOKEN);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(INVITATION_TOKEN);
    expect(`${window.location.pathname}${window.location.search}`).toBe("/invitations/accept?x=1");
    expect(window.history.state).toEqual({ kept: true });
  });

  it("strips a fragment without a token and reports nothing to accept", () => {
    window.history.replaceState(null, "", "/invitations/accept#other=1");
    expect(takeInvitationToken(window.location, window.history)).toBeUndefined();
    expect(window.location.hash).toBe("");
    window.history.replaceState(null, "", "/invitations/accept");
    expect(takeInvitationToken(window.location, window.history)).toBeUndefined();
  });
});

describe("session store: creating and revoking invitations", () => {
  it("sends one UUIDv7 key per logical submission and reuses it when retrying the same role", async () => {
    const api = registeredUserApi().on(
      `POST ${INVITATIONS_PATH}`,
      networkError,
      json(201, { invitation: INVITATION, tokenAvailable: true, token: INVITATION_TOKEN }),
    );
    const store = await ownerWithBusinessSelected(api);

    expect(await store.createInvitation(BUSINESS_A.id, "CASHIER")).toMatchObject({ status: "failed" });
    const created = await store.createInvitation(BUSINESS_A.id, "CASHIER");
    expect(created).toEqual({ status: "created", invitation: INVITATION, token: INVITATION_TOKEN });

    const sent = api.to(`POST ${INVITATIONS_PATH}`);
    expect(sent.map((request) => request.body)).toEqual([{ role: "CASHIER" }, { role: "CASHIER" }]);
    const keys = sent.map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "");
    expect(isUuidV7(keys[0] ?? "")).toBe(true);
    expect(keys[1]).toBe(keys[0]);

    await store.createInvitation(BUSINESS_A.id, "MANAGER");
    const third = api.to(`POST ${INVITATIONS_PATH}`)[2]?.headers.get(IDEMPOTENCY_KEY_HEADER);
    expect(third).not.toBe(keys[0]);
    expect(JSON.stringify(store.getSnapshot())).not.toContain(INVITATION_TOKEN);
  });

  it("reports a replay as already shown, without a token", async () => {
    const api = registeredUserApi().on(
      `POST ${INVITATIONS_PATH}`,
      json(201, { invitation: INVITATION, tokenAvailable: false }),
    );
    const store = await ownerWithBusinessSelected(api);
    expect(await store.createInvitation(BUSINESS_A.id, "CASHIER")).toEqual({
      status: "alreadyShown",
      invitation: INVITATION,
    });
  });

  it("ignores a business that is not selected and returns server refusals unchanged", async () => {
    const api = registeredUserApi().on(`POST ${INVITATIONS_PATH}`, apiError(403, "PERMISSION_DENIED"));
    const store = await ownerWithBusinessSelected(api);
    expect(await store.createInvitation(BUSINESS_B.id, "CASHIER")).toEqual({ status: "ignored" });
    const denied = await store.createInvitation(BUSINESS_A.id, "CASHIER");
    expect(denied).toMatchObject({ status: "failed", failure: { code: "PERMISSION_DENIED" } });
    expect(store.getSnapshot().phase).toBe("businessSelected");
  });

  it("revokes by ID in the selected business", async () => {
    const route = `POST ${INVITATIONS_PATH}/${INVITATION.id}/revoke`;
    const api = registeredUserApi().on(route, json(200, { invitation: { ...INVITATION, status: "REVOKED" } }));
    const store = await ownerWithBusinessSelected(api);
    expect(await store.revokeInvitation(BUSINESS_A.id, INVITATION.id)).toEqual({
      status: "revoked",
      invitation: { ...INVITATION, status: "REVOKED" },
    });
    expect(api.to(route)).toHaveLength(1);
  });
});

describe("session store: accepting an invitation", () => {
  it("holds the token in memory before sign-in and sends it only in the accept body", async () => {
    const api = registeredUserApi([BUSINESS_A]).on(ACCEPT_ROUTE, json(200, acceptedBody()));
    const store = storeFor(api);
    store.holdInvitation(INVITATION_TOKEN);
    expect(store.getSnapshot().hasPendingInvitation).toBe(true);
    await store.signInLocal("local-user-ada");
    expect(store.getSnapshot()).toMatchObject({ phase: "choosingBusiness", hasPendingInvitation: true });

    api.on(
      "GET /v1/me/businesses",
      json(200, {
        items: [
          { business: BUSINESS_A, membership: MEMBERSHIP_A },
          { business: BUSINESS_B, membership: { id: acceptedBody().membership.id, role: "CASHIER" } },
        ],
        nextCursor: null,
      }),
    );
    await store.acceptInvitation();
    expect(api.to(ACCEPT_ROUTE).map((request) => request.body)).toEqual([{ token: INVITATION_TOKEN }]);
    for (const request of api.requests) {
      expect(`${request.path}${request.query}`).not.toContain(INVITATION_TOKEN);
      expect([...request.headers.values()].join(" ")).not.toContain(INVITATION_TOKEN);
    }
    expect(store.getSnapshot()).toMatchObject({
      phase: "choosingBusiness",
      notice: "invitationAccepted",
      hasPendingInvitation: false,
    });
    expect(store.getSnapshot().businesses.map((item) => item.business.id)).toEqual([BUSINESS_A.id, BUSINESS_B.id]);
    await store.acceptInvitation();
    expect(api.to(ACCEPT_ROUTE)).toHaveLength(1);
  });

  it.each(["NOT_FOUND", "CONFLICT"])("drops the token after %s, which can never succeed", async (code) => {
    const api = registeredUserApi().on(ACCEPT_ROUTE, apiError(code === "NOT_FOUND" ? 404 : 409, code));
    const store = storeFor(api);
    store.holdInvitation(INVITATION_TOKEN);
    await store.signInLocal("local-user-ada");
    await store.acceptInvitation();
    expect(store.getSnapshot()).toMatchObject({
      hasPendingInvitation: false,
      error: { action: "acceptInvitation", failure: { code } },
    });
  });

  it("keeps the token for a retry after a network failure or rate limit", async () => {
    const api = registeredUserApi().on(
      ACCEPT_ROUTE,
      networkError,
      apiError(429, "RATE_LIMITED"),
      json(200, acceptedBody()),
    );
    const store = storeFor(api);
    store.holdInvitation(INVITATION_TOKEN);
    await store.signInLocal("local-user-ada");
    await store.acceptInvitation();
    expect(store.getSnapshot().hasPendingInvitation).toBe(true);
    await store.acceptInvitation();
    expect(store.getSnapshot().hasPendingInvitation).toBe(true);
    await store.acceptInvitation();
    expect(store.getSnapshot()).toMatchObject({ hasPendingInvitation: false, notice: "invitationAccepted" });
  });

  it("does not accept before the user is registered, and sign-out forgets the token", async () => {
    const api = registeredUserApi().on("GET /v1/me", apiError(403, "USER_NOT_REGISTERED"));
    const store = storeFor(api);
    store.holdInvitation(INVITATION_TOKEN);
    await store.signInLocal("local-user-new");
    expect(store.getSnapshot().phase).toBe("needsRegistration");
    await store.acceptInvitation();
    expect(api.to(ACCEPT_ROUTE)).toHaveLength(0);
    store.signOut();
    expect(store.getSnapshot().hasPendingInvitation).toBe(false);
  });
});

function renderWith(api: FakeTaliApi, invitationPage = false) {
  vi.stubGlobal("fetch", api.fetch);
  return render(<OnboardingApp config={LOCAL} invitationLink={invitationPage} />);
}

async function signIn(subject = "local-user-ada") {
  fireEvent.change(screen.getByLabelText("Local subject"), { target: { value: subject } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in (local development)" }));
}

describe("invitation screens", () => {
  it("an owner creates a link shown once, copies it, dismisses it and revokes the invitation", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const api = registeredUserApi()
      .on(
        `POST ${INVITATIONS_PATH}`,
        json(201, { invitation: INVITATION, tokenAvailable: true, token: INVITATION_TOKEN }),
      )
      .on(
        `POST ${INVITATIONS_PATH}/${INVITATION.id}/revoke`,
        json(200, { invitation: { ...INVITATION, status: "REVOKED" } }),
      );
    renderWith(api);
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: /Ada Provisions/u }));
    const panel = await screen.findByRole("region", { name: "Invite someone" });
    fireEvent.change(within(panel).getByLabelText("Role"), { target: { value: "CASHIER" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Create invitation link" }));

    const link = await within(panel).findByLabelText("Invitation link");
    const expected = `${window.location.origin}/invitations/accept#token=${INVITATION_TOKEN}`;
    expect((link as HTMLInputElement).value).toBe(expected);
    expect(within(panel).getByText(/This link is shown once\./u)).toBeDefined();
    expect(within(panel).getByText(/cannot show it again/u)).toBeDefined();

    fireEvent.click(within(panel).getByRole("button", { name: "Copy link" }));
    await act(settle);
    expect(writeText).toHaveBeenCalledWith(expected);

    fireEvent.click(within(panel).getByRole("button", { name: "Done" }));
    expect(within(panel).queryByLabelText("Invitation link")).toBeNull();
    expect(document.body.innerHTML).not.toContain(INVITATION_TOKEN);

    const row = within(panel).getByRole("row", { name: /Cashier/u });
    expect(row.textContent).toContain("Pending");
    fireEvent.click(within(row).getByRole("button", { name: "Revoke" }));
    await act(settle);
    expect(within(panel).getByRole("row", { name: /Cashier/u }).textContent).toContain("Revoked");
    expectNothingPersisted();
  });

  it("says a replayed invitation link cannot be shown again", async () => {
    const api = registeredUserApi().on(
      `POST ${INVITATIONS_PATH}`,
      json(201, { invitation: INVITATION, tokenAvailable: false }),
    );
    renderWith(api);
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: /Ada Provisions/u }));
    const panel = await screen.findByRole("region", { name: "Invite someone" });
    fireEvent.click(within(panel).getByRole("button", { name: "Create invitation link" }));
    expect(await within(panel).findByText(/its link cannot be shown again/u)).toBeDefined();
    expect(within(panel).queryByLabelText("Invitation link")).toBeNull();
  });

  it("offers no invitation panel to a member who is not an owner", async () => {
    const api = registeredUserApi().on(
      "GET /v1/me/businesses",
      json(200, {
        items: [{ business: BUSINESS_A, membership: { ...MEMBERSHIP_A, role: "CASHIER" } }],
        nextCursor: null,
      }),
    );
    renderWith(api);
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: /Ada Provisions/u }));
    await screen.findByRole("heading", { level: 2, name: "Ada Provisions" });
    await act(settle);
    expect(screen.queryByRole("region", { name: "Invite someone" })).toBeNull();
  });

  it("the accept page strips the fragment, waits for sign-in, accepts and shows the business in the picker", async () => {
    window.history.replaceState(null, "", `/invitations/accept#token=${INVITATION_TOKEN}`);
    const api = registeredUserApi([BUSINESS_A]).on(ACCEPT_ROUTE, json(200, acceptedBody()));
    renderWith(api, true);
    await act(settle);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(INVITATION_TOKEN);
    expect(screen.getByTestId("invitation-waiting")).toBeDefined();

    await signIn();
    const accept = await screen.findByRole("button", { name: "Accept invitation" });
    api.on(
      "GET /v1/me/businesses",
      json(200, {
        items: [
          { business: BUSINESS_A, membership: MEMBERSHIP_A },
          { business: BUSINESS_B, membership: { id: acceptedBody().membership.id, role: "CASHIER" } },
        ],
        nextCursor: null,
      }),
    );
    fireEvent.click(accept);
    expect(await screen.findByText("Invitation accepted. The business is now in your list.")).toBeDefined();
    expect(screen.getByRole("button", { name: /Obi General Store/u })).toBeDefined();
    expect(api.to(ACCEPT_ROUTE).map((request) => request.body)).toEqual([{ token: INVITATION_TOKEN }]);
    expect(document.body.innerHTML).not.toContain(INVITATION_TOKEN);
    expectNothingPersisted();
  });

  it("shows one message for an unusable invitation", async () => {
    window.history.replaceState(null, "", `/invitations/accept#token=${INVITATION_TOKEN}`);
    const api = registeredUserApi().on(ACCEPT_ROUTE, apiError(404, "NOT_FOUND", "Invitation not found"));
    renderWith(api, true);
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect((await screen.findByRole("alert")).textContent).toContain("This invitation cannot be used.");
    expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "Invitation" })).toBeNull();
  });

  it("says a link without a token is incomplete", async () => {
    window.history.replaceState(null, "", "/invitations/accept");
    renderWith(registeredUserApi(), true);
    await act(settle);
    expect(screen.getByTestId("invitation-link-incomplete")).toBeDefined();
  });
});
