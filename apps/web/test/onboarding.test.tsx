import type { WebPublicConfig } from "@tali/config/public";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_KEY_HEADER } from "../src/lib/api-client/tali-api-client";
import { OnboardingApp } from "../src/onboarding/onboarding-app";
import {
  apiError,
  BUSINESS_A,
  BUSINESS_B,
  createdBusinessBody,
  deferred,
  type FakeTaliApi,
  json,
  MEMBERSHIP_A,
  networkError,
  registeredUserApi,
  TOKEN,
  USER,
} from "./support/fake-tali-api";

const LOCAL: WebPublicConfig = { env: "local", apiBaseUrl: "http://api.test", authMode: "local" };

function renderWith(api: FakeTaliApi, config: WebPublicConfig = LOCAL) {
  vi.stubGlobal("fetch", api.fetch);
  return render(<OnboardingApp config={config} />);
}

async function signIn(subject = "local-user-ada") {
  fireEvent.change(screen.getByLabelText("Local subject"), { target: { value: subject } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in (local development)" }));
}

function expectNothingPersisted() {
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(document.cookie).toBe("");
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signed-out view and local sign-in gating", () => {
  it("offers local development sign-in, clearly marked, when TALI_ENV=local", () => {
    renderWith(registeredUserApi());
    expect(screen.getByRole("heading", { name: "Local development sign-in" })).toBeDefined();
    expect(screen.getByText(/not a production sign-in method/u)).toBeDefined();
    expect(screen.queryByLabelText(/password/iu)).toBeNull();
  });

  it.each(["test", "development", "staging", "production"] as const)(
    "offers no sign-in and calls nothing when TALI_ENV=%s",
    (env) => {
      const api = registeredUserApi();
      renderWith(api, { env, apiBaseUrl: "https://api.example.test", authMode: "unavailable" });
      expect(screen.getByTestId("sign-in-unavailable")).toBeDefined();
      expect(screen.queryByLabelText("Local subject")).toBeNull();
      expect(api.requests).toHaveLength(0);
    },
  );

  it("validates the subject with the shared contract before calling the API", async () => {
    const api = registeredUserApi();
    renderWith(api);
    await signIn("bad subject!");
    expect(screen.getByText(/The subject must be 1 to 64 letters/u)).toBeDefined();
    expect(screen.getByLabelText("Local subject").getAttribute("aria-invalid")).toBe("true");
    expect(api.requests).toHaveLength(0);
  });

  it("shows the loading state while signing in", async () => {
    const pending = deferred();
    renderWith(registeredUserApi().on("POST /__local/sign-in", pending.reply));
    await signIn();
    expect(screen.getByRole("status").textContent).toBe("Signing in…");
  });

  it("shows a retryable message when the API cannot be reached", async () => {
    renderWith(registeredUserApi().on("POST /__local/sign-in", networkError));
    await signIn();
    expect((await screen.findByRole("alert")).textContent).toContain("Tali could not be reached");
  });
});

describe("first-time onboarding", () => {
  it("signs in, registers, creates the first business and shows its overview and members, then signs out", async () => {
    const api = registeredUserApi([])
      .on("GET /v1/me", apiError(403, "USER_NOT_REGISTERED"))
      .on("POST /v1/me/registration", json(201, USER))
      .on("POST /v1/businesses", json(201, createdBusinessBody()))
      .on(
        "GET /v1/me/businesses",
        json(200, { items: [], nextCursor: null }),
        json(200, { items: [{ business: BUSINESS_A, membership: MEMBERSHIP_A }], nextCursor: null }),
      );
    renderWith(api);
    await signIn();

    expect(await screen.findByRole("heading", { name: "Set up your profile" })).toBeDefined();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada Obi" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Create your first business" })).toBeDefined();
    expect(screen.getByText("Signed in as Ada Obi")).toBeDefined();
    expect(screen.getByText("NGN")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Business name"), { target: { value: "Ada Provisions" } });
    fireEvent.change(screen.getByLabelText(/^Time zone/u), { target: { value: "Africa/Lagos" } });
    fireEvent.click(screen.getByRole("button", { name: "Create business" }));

    expect(await screen.findByRole("heading", { name: "Ada Provisions" })).toBeDefined();
    const overview = screen.getByRole("heading", { name: "Ada Provisions" }).closest("section");
    expect(overview).not.toBeNull();
    const details = within(overview as HTMLElement);
    expect(details.getByText("Currency").nextElementSibling?.textContent).toBe("NGN");
    expect(details.getByText("Time zone").nextElementSibling?.textContent).toBe("Africa/Lagos");
    expect(details.getByText("Default location").nextElementSibling?.textContent).toBe("Ada Provisions");
    const members = await screen.findByRole("table");
    expect(within(members).getByText("Ada Obi")).toBeDefined();
    expect(within(members).getByText("Owner")).toBeDefined();

    expect(api.to("POST /v1/businesses")[0]?.body).toEqual({
      name: "Ada Provisions",
      currencyCode: "NGN",
      timeZone: "Africa/Lagos",
    });
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.body.textContent).not.toContain(
      api.to("POST /v1/businesses")[0]?.headers.get(IDEMPOTENCY_KEY_HEADER),
    );
    expect(window.location.href).not.toContain(TOKEN);
    expectNothingPersisted();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByRole("heading", { name: "Local development sign-in" })).toBeDefined();
    expect(screen.getByText("You have signed out.")).toBeDefined();
    expect(screen.queryByText("Ada Provisions")).toBeNull();
    expectNothingPersisted();
  });

  it("shows field errors from the server's VALIDATION_FAILED response", async () => {
    const api = registeredUserApi([]).on(
      "POST /v1/businesses",
      apiError(400, "VALIDATION_FAILED", "Request validation failed", [{ path: ["timeZone"], message: "invalid" }]),
    );
    renderWith(api);
    await signIn();
    fireEvent.change(await screen.findByLabelText("Business name"), { target: { value: "Ada Provisions" } });
    fireEvent.change(screen.getByLabelText(/^Time zone/u), { target: { value: "+01:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Create business" }));
    expect(await screen.findByText(/did not recognise this time zone/u)).toBeDefined();
    expect(screen.getByLabelText(/^Time zone/u).getAttribute("aria-invalid")).toBe("true");
  });

  it("requires a name and time zone before sending", async () => {
    const api = registeredUserApi([]);
    renderWith(api);
    await signIn();
    fireEvent.change(await screen.findByLabelText(/^Time zone/u), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create business" }));
    expect(screen.getByText(/Enter the business name/u)).toBeDefined();
    expect(screen.getByText(/Enter the business time zone/u)).toBeDefined();
    expect(api.to("POST /v1/businesses")).toHaveLength(0);
  });
});

describe("CreateBusiness submission safety", () => {
  async function toCreateForm(api: FakeTaliApi) {
    renderWith(api);
    await signIn();
    fireEvent.change(await screen.findByLabelText("Business name"), { target: { value: "Ada Provisions" } });
    fireEvent.change(screen.getByLabelText(/^Time zone/u), { target: { value: "Africa/Lagos" } });
  }

  it("sends one request for a double click and disables the button while it is in flight", async () => {
    const pending = deferred();
    const api = registeredUserApi([]).on("POST /v1/businesses", pending.reply);
    await toCreateForm(api);
    const button = screen.getByRole("button", { name: "Create business" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    expect(await screen.findByRole("button", { name: "Creating business…" })).toHaveProperty("disabled", true);
    await act(async () => {
      pending.resolve(201, createdBusinessBody());
      await Promise.resolve();
    });
    expect(await screen.findByRole("heading", { name: "Ada Provisions" })).toBeDefined();
    expect(api.to("POST /v1/businesses")).toHaveLength(1);
  });

  it("retries a network failure with the same Idempotency-Key", async () => {
    const api = registeredUserApi([]).on("POST /v1/businesses", networkError, json(201, createdBusinessBody()));
    await toCreateForm(api);
    fireEvent.click(screen.getByRole("button", { name: "Create business" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Tali could not be reached");
    expect(screen.getByText(/will not create a second business/u)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Try again with the same details" }));
    expect(await screen.findByRole("heading", { name: "Ada Provisions" })).toBeDefined();
    const keys = api.to("POST /v1/businesses").map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe("business picker and overview", () => {
  it("lists only the server's businesses and opens the chosen one", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B]);
    renderWith(api);
    await signIn();
    expect(await screen.findByRole("heading", { name: "Choose a business" })).toBeDefined();
    expect(screen.getByRole("button", { name: /Obi General Store/u })).toBeDefined();
    expect(screen.queryByLabelText(/business id/iu)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Ada Provisions/u }));
    expect(await screen.findByRole("heading", { name: "Ada Provisions" })).toBeDefined();
    expect(screen.getByText("Your role").nextElementSibling?.textContent).toBe("Owner");

    fireEvent.click(screen.getByRole("button", { name: "Switch business" }));
    expect(await screen.findByRole("heading", { name: "Choose a business" })).toBeDefined();
  });

  it("shows the members list as not available on PERMISSION_DENIED, not as empty", async () => {
    const api = registeredUserApi().on(
      `GET /v1/businesses/${BUSINESS_A.id}/members`,
      apiError(403, "PERMISSION_DENIED", "Denied"),
    );
    renderWith(api);
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: /Ada Provisions/u }));
    expect(await screen.findByTestId("members-not-available")).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("No members to show.")).toBeNull();
    expect(screen.getByRole("heading", { name: "Ada Provisions" })).toBeDefined();
  });

  it("shows an empty members list only when the server returns one", async () => {
    const api = registeredUserApi().on(
      `GET /v1/businesses/${BUSINESS_A.id}/members`,
      json(200, { items: [], nextCursor: null }),
    );
    renderWith(api);
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: /Ada Provisions/u }));
    expect(await screen.findByText("No members to show.")).toBeDefined();
  });

  it("returns to the picker with generic wording when the selected business answers NOT_FOUND", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B]).on(
      `GET /v1/businesses/${BUSINESS_A.id}`,
      apiError(404, "NOT_FOUND", "Business not found"),
    );
    renderWith(api);
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: /Ada Provisions/u }));
    expect(await screen.findByText("That business is no longer available to you.")).toBeDefined();
    expect(await screen.findByRole("heading", { name: "Choose a business" })).toBeDefined();
    expect(screen.queryByText("Business not found")).toBeNull();
  });

  it("returns to sign-in when the token is rejected", async () => {
    const api = registeredUserApi().on(`GET /v1/businesses/${BUSINESS_A.id}`, apiError(401, "UNAUTHENTICATED"));
    renderWith(api);
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: /Ada Provisions/u }));
    expect(await screen.findByText("Your session has ended. Sign in again.")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Local development sign-in" })).toBeDefined();
    expect(screen.queryByText("Signed in as Ada Obi")).toBeNull();
  });

  it("does not render a malformed business response", async () => {
    const api = registeredUserApi().on(`GET /v1/businesses/${BUSINESS_A.id}`, json(200, { ...BUSINESS_A, extra: 1 }));
    renderWith(api);
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: /Ada Provisions/u }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not read");
    expect(screen.queryByText("Default location")).toBeNull();
  });

  it("moves focus to the heading of each new screen", async () => {
    renderWith(registeredUserApi([BUSINESS_A, BUSINESS_B]));
    await signIn();
    const heading = await screen.findByRole("heading", { name: "Choose a business" });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });
});
