import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { E2E } from "../playwright.config";

// The disposable test database keeps data between runs, so each run uses new local subjects.
const run = randomBytes(6).toString("hex");
const ownerSubject = `e2e-inviter-${run}`;
const inviteeSubject = `e2e-invitee-${run}`;
const businessName = `Invite Provisions ${run}`;

test.use({ timezoneId: "Africa/Lagos" });

async function signInAndRegister(page: Page, subject: string, displayName: string): Promise<string> {
  await expect(page.getByRole("heading", { name: "Local development sign-in" })).toBeVisible();
  const signInResponse = page.waitForResponse(`${E2E.apiOrigin}/__local/sign-in`);
  await page.getByLabel("Local subject").fill(subject);
  await page.getByRole("button", { name: "Sign in (local development)" }).click();
  const body = (await (await signInResponse).json()) as { accessToken: string };
  await expect(page.getByRole("heading", { name: "Set up your profile" })).toBeVisible();
  await page.getByLabel("Your name").fill(displayName);
  await page.getByRole("button", { name: "Continue" }).click();
  return body.accessToken;
}

async function expectSecretNowhere(page: Page, secret: string): Promise<void> {
  expect(page.url()).not.toContain(secret);
  expect(page.url()).not.toContain("#");
  expect(await page.context().cookies()).toEqual([]);
  const stored = await page.evaluate(async () => {
    const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    return {
      local: JSON.stringify(Object.fromEntries(Object.entries(window.localStorage))),
      session: JSON.stringify(Object.fromEntries(Object.entries(window.sessionStorage))),
      cookie: document.cookie,
      indexedDb: databases.map((database) => database.name ?? ""),
      history: window.history.state === null ? "" : JSON.stringify(window.history.state),
    };
  });
  expect({ ...stored, history: undefined }).toEqual({
    local: "{}",
    session: "{}",
    cookie: "",
    indexedDb: [],
    history: undefined,
  });
  expect(stored.history).not.toContain(secret);
  expect(await page.content()).not.toContain(secret);
}

test("an owner invites a new user through a one-time link, and the invitee joins the business", async ({
  browser,
  page,
}) => {
  await page.goto("/");
  await signInAndRegister(page, ownerSubject, "Ngozi Eze");
  await expect(page.getByRole("heading", { name: "Create your first business" })).toBeVisible();
  await page.getByLabel("Business name").fill(businessName);
  await page.getByRole("button", { name: "Create business" }).click();
  await expect(page.getByRole("heading", { level: 2, name: businessName })).toBeVisible();

  const panel = page.getByRole("region", { name: "Invite someone" });
  await panel.getByLabel("Role").selectOption("CASHIER");
  const created = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/invitations"),
  );
  await panel.getByRole("button", { name: "Create invitation link" }).click();
  const createdResponse = await created;
  expect(createdResponse.status()).toBe(201);
  expect(createdResponse.headers()["cache-control"]).toBe("no-store");
  await expect(panel.getByText("This link is shown once.")).toBeVisible();
  const link = await panel.getByLabel("Invitation link").inputValue();
  expect(link.startsWith(`${E2E.webOrigin}/invitations/accept#token=`)).toBe(true);
  const invitationToken = decodeURIComponent(link.slice(link.indexOf("#token=") + "#token=".length));
  expect(invitationToken.length).toBeGreaterThan(20);
  await panel.getByRole("button", { name: "Done" }).click();
  await expect(panel.getByLabel("Invitation link")).toHaveCount(0);
  await expectSecretNowhere(page, invitationToken);

  // The invitee opens the link in a separate browser profile.
  const inviteeContext = await browser.newContext({ timezoneId: "Africa/Lagos" });
  const invitee = await inviteeContext.newPage();
  const documentRequests: string[] = [];
  invitee.on("request", (request) => {
    if (request.url().startsWith(E2E.webOrigin)) documentRequests.push(request.url());
  });
  await invitee.goto(link);
  await expect(invitee.getByTestId("invitation-waiting")).toBeVisible();
  expect(invitee.url()).toBe(`${E2E.webOrigin}/invitations/accept`);
  await expectSecretNowhere(invitee, invitationToken);

  await signInAndRegister(invitee, inviteeSubject, "Tunde Bello");
  const accept = invitee.getByRole("button", { name: "Accept invitation" });
  await expect(accept).toBeVisible();
  const acceptRequest = invitee.waitForRequest(
    (request) => request.method() === "POST" && request.url() === `${E2E.apiOrigin}/v1/invitations/accept`,
  );
  const acceptResponse = invitee.waitForResponse(`${E2E.apiOrigin}/v1/invitations/accept`);
  await accept.click();
  expect((await acceptRequest).postDataJSON()).toEqual({ token: invitationToken });
  expect((await acceptResponse).status()).toBe(200);

  await expect(invitee.getByText("Invitation accepted. The business is now in your list.")).toBeVisible();
  await expect(invitee.getByRole("button", { name: new RegExp(businessName, "u") })).toContainText("Cashier");
  await expectSecretNowhere(invitee, invitationToken);
  for (const url of documentRequests) expect(url).not.toContain(invitationToken);

  // The invitee works in the business with the invited role, without owner controls.
  await invitee.getByRole("button", { name: new RegExp(businessName, "u") }).click();
  await expect(invitee.getByRole("heading", { level: 2, name: businessName })).toBeVisible();
  await expect(invitee.getByRole("region", { name: "Invite someone" })).toHaveCount(0);
  await inviteeContext.close();
});
