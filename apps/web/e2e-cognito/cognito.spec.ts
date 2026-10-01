import { expect, type BrowserContext, type Page, type Route, test } from "@playwright/test";
import { COGNITO_E2E } from "../playwright.cognito.config";
import { FAKE_CHALLENGE_SESSION, FAKE_COGNITO_HOST, FakeCognito } from "../test/support/fake-cognito";

/*
 * Cognito-mode web build in Chromium with the real aws-amplify bundle. The
 * Cognito endpoint and the Tali API are page.route fakes; any other external
 * request is refused and recorded. Proves ADR-003 section 14.4 in a real
 * browser: tokens are memory-only, a reload loses the session, the password
 * goes nowhere but Cognito's SRP exchange, and sign-out leaves nothing.
 */

const EMAIL = "pilot.owner@example.test";
const PASSWORD = "Synthetic-Passw0rd-For-Browser";
const USER = { id: "0191a1b2-0000-7000-8000-000000000001", displayName: "Ada Obi" };

interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

class Harness {
  readonly cognito = new FakeCognito();
  readonly api: ApiRequest[] = [];
  readonly refused: string[] = [];
  readonly requestUrls: string[] = [];
  readonly consoleText: string[] = [];
  registered = false;

  constructor(readonly page: Page) {}

  async install(context: BrowserContext) {
    this.page.on("request", (request) => this.requestUrls.push(request.url()));
    this.page.on("console", (message) => this.consoleText.push(message.text()));
    // Routes are matched newest first: the refusal is the fallback.
    await context.route(
      (url) => url.origin !== COGNITO_E2E.webOrigin,
      async (route) => {
        this.refused.push(new URL(route.request().url()).host);
        await route.abort("blockedbyclient");
      },
    );
    await context.route(`https://${FAKE_COGNITO_HOST}/**`, (route) => this.#cognito(route));
    await context.route(`${COGNITO_E2E.apiOrigin}/**`, (route) => this.#api(route));
  }

  /** Every token value issued plus the password: none may be found in browser state. */
  secrets(): string[] {
    const { access, id, refresh } = this.cognito.issued;
    return [...access, ...id, ...refresh, PASSWORD];
  }

  async browserState() {
    return this.page.evaluate(async () => {
      const dump = (storage: Storage) =>
        Array.from({ length: storage.length }, (_, index) => {
          const key = storage.key(index) ?? "";
          return `${key}=${storage.getItem(key) ?? ""}`;
        });
      return {
        local: dump(window.localStorage),
        session: dump(window.sessionStorage),
        cookie: document.cookie,
        indexedDb: (await indexedDB.databases()).map((database) => database.name ?? ""),
      };
    });
  }

  /** No token or password in any storage, cookie, URL, page content or console output. */
  async expectNoSecretsAnywhere() {
    const state = JSON.stringify(await this.browserState());
    const cookies = JSON.stringify(await this.page.context().cookies());
    const content = await this.page.content();
    for (const secret of this.secrets()) {
      expect(state).not.toContain(secret);
      expect(cookies).not.toContain(secret);
      expect(content).not.toContain(secret);
      expect(this.page.url()).not.toContain(secret);
      expect(this.requestUrls.join("\n")).not.toContain(secret);
      expect(this.consoleText.join("\n")).not.toContain(secret);
    }
    expect(await this.page.context().cookies()).toEqual([]);
    const { local, indexedDb } = await this.browserState();
    expect(local).toEqual([]);
    expect(indexedDb).toEqual([]);
  }

  async #cognito(route: Route) {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: this.#cors(request.headers()) });
    const answer = await this.cognito.respond(request.headers()["x-amz-target"] ?? "", request.postData() ?? "");
    return route.fulfill({
      status: answer.status,
      body: answer.body,
      headers: { ...this.#cors(request.headers()), "content-type": "application/x-amz-json-1.1" },
    });
  }

  async #api(route: Route) {
    const request = route.request();
    const headers = this.#cors(request.headers());
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const path = new URL(request.url()).pathname;
    this.api.push({
      method: request.method(),
      path,
      authorization: request.headers()["authorization"],
      body: request.postData() ?? "",
    });
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        body: JSON.stringify(body),
        headers: { ...headers, "content-type": "application/json" },
      });
    switch (`${request.method()} ${path}`) {
      case "GET /health/ready":
        return reply(200, { status: "ready", checks: { database: "up" } });
      case "GET /v1/me":
        return this.registered
          ? reply(200, USER)
          : reply(403, { error: { code: "USER_NOT_REGISTERED", message: "Registration required" } });
      case "POST /v1/me/registration":
        this.registered = true;
        return reply(201, USER);
      case "GET /v1/me/businesses":
        return reply(200, { items: [], nextCursor: null });
      default:
        return reply(404, { error: { code: "NOT_FOUND", message: "Not found" } });
    }
  }

  #cors(requestHeaders: Record<string, string>): Record<string, string> {
    return {
      "access-control-allow-origin": COGNITO_E2E.webOrigin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": requestHeaders["access-control-request-headers"] ?? "*",
      "access-control-expose-headers": "x-correlation-id",
    };
  }
}

async function signIn(page: Page) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email address").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

let harness: Harness;

test.beforeEach(async ({ page, context }) => {
  harness = new Harness(page);
  await harness.install(context);
});

test.afterEach(() => {
  expect(harness.refused).toEqual([]);
});

test("SRP sign-in and registration keep every token in memory; a reload loses the session", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Set up your profile" })).toBeVisible();
  await page.getByLabel("Your name").fill("Ada Obi");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Create your first business" })).toBeVisible();

  // SRP only, and the password never left the page in any request.
  const initiate = harness.cognito.calls.find((call) => call.op === "InitiateAuth");
  expect(initiate?.body["AuthFlow"]).toBe("USER_SRP_AUTH");
  for (const call of harness.cognito.calls) expect(JSON.stringify(call.body)).not.toContain(PASSWORD);
  for (const request of harness.api) expect(request.body).not.toContain(PASSWORD);

  // The Tali API received Cognito access tokens only, never the ID token.
  const bearers = harness.api.flatMap((request) =>
    request.authorization === undefined ? [] : [request.authorization],
  );
  expect(bearers.length).toBeGreaterThanOrEqual(3);
  for (const bearer of bearers) {
    expect(harness.cognito.issued.access.map((token) => `Bearer ${token}`)).toContain(bearer);
  }
  expect(JSON.stringify(harness.api)).not.toContain(EMAIL);

  // Nothing persisted: no tokens anywhere, and Amplify's transient sign-in state is gone after sign-in.
  await harness.expectNoSecretsAnywhere();
  expect((await harness.browserState()).session).toEqual([]);

  const authorizedBefore = harness.api.filter((request) => request.authorization !== undefined).length;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveValue("");
  expect(harness.api.filter((request) => request.authorization !== undefined).length).toBe(authorizedBefore);
  expect(harness.cognito.ops().filter((op) => op === "GetTokensFromRefreshToken")).toEqual([]);
  await harness.expectNoSecretsAnywhere();
});

test("expired access tokens refresh with GetTokensFromRefreshToken and rotation, never REFRESH_TOKEN_AUTH", async ({
  page,
}) => {
  harness.cognito.options.accessLifetimeSeconds = 1;
  harness.registered = true;
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Create your first business" })).toBeVisible();

  const refreshes = harness.cognito.calls.filter((call) => call.op === "GetTokensFromRefreshToken");
  expect(refreshes.length).toBeGreaterThanOrEqual(1);
  refreshes.forEach((call, index) => {
    expect(call.body["RefreshToken"]).toBe(harness.cognito.issued.refresh[index]);
  });
  expect(harness.cognito.calls.some((call) => call.body["AuthFlow"] === "REFRESH_TOKEN_AUTH")).toBe(false);
  await harness.expectNoSecretsAnywhere();
  expect((await harness.browserState()).session).toEqual([]);
});

test("sign-out revokes the refresh token; sign-out on all devices uses GlobalSignOut; nothing remains", async ({
  page,
}) => {
  harness.registered = true;
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Create your first business" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("You have signed out.")).toBeVisible();
  await expect.poll(() => harness.cognito.ops().includes("RevokeToken")).toBe(true);
  const revoke = harness.cognito.calls.find((call) => call.op === "RevokeToken");
  expect(revoke?.body["Token"]).toBe(harness.cognito.issued.refresh.at(-1));
  await harness.expectNoSecretsAnywhere();
  expect((await harness.browserState()).session).toEqual([]);

  await signIn(page);
  await expect(page.getByRole("heading", { name: "Create your first business" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out on all devices" }).click();
  await expect(page.getByText("You have signed out.")).toBeVisible();
  await expect.poll(() => harness.cognito.ops().includes("GlobalSignOut")).toBe(true);
  await harness.expectNoSecretsAnywhere();
  expect((await harness.browserState()).session).toEqual([]);
});

test("an unsupported extra Cognito challenge fails safely and exposes nothing", async ({ page }) => {
  harness.cognito.options.furtherChallenge = "SOFTWARE_TOKEN_MFA";
  await page.goto("/");
  await signIn(page);
  await expect(page.getByTestId("cognito-message")).toHaveText(
    "This account needs an extra sign-in step that this version of Tali cannot complete. Contact Tali support.",
  );
  await expect(page.getByLabel("Password")).toHaveValue("");
  expect(await page.content()).not.toContain(FAKE_CHALLENGE_SESSION);
  expect(harness.api.filter((request) => request.authorization !== undefined)).toEqual([]);
  // Amplify may keep its own transient challenge state in session storage until it expires (documented in
  // docs/audits/build-1-slice-6.md); it holds no token and no password, and Tali never reads it.
  await harness.expectNoSecretsAnywhere();
});

test("a wrong password shows bounded wording and keeps nothing", async ({ page }) => {
  harness.cognito.options.signInError = "NotAuthorizedException";
  await page.goto("/");
  await signIn(page);
  await expect(page.getByTestId("cognito-message")).toHaveText("The email or password is not correct.");
  await expect(page.getByLabel("Password")).toHaveValue("");
  expect(await page.content()).not.toContain("synthetic NotAuthorizedException");
  await harness.expectNoSecretsAnywhere();
  expect((await harness.browserState()).session).toEqual([]);
});
