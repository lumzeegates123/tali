import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CatalogStore } from "../src/catalog/catalog-store";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/lib/api-client/tali-api-client";
import { SessionStore } from "../src/lib/auth/session-store";
import { newUuidV7 } from "../src/lib/ids/uuidv7";
import { categoryFixture, NGN, productFixture, UNITS } from "./support/catalog-fixtures";
import { BUSINESS_A, json, registeredUserApi, settle, TOKEN } from "./support/fake-tali-api";

const CATALOG_SOURCE = join(import.meta.dirname, "..", "src", "catalog");
const BASE = `/v1/businesses/${BUSINESS_A.id}`;

/** Property names that would carry a secret. Exact identifiers only: `credentialsCount` or `tokenized` do not match. */
const SECRET_KEY =
  /^(?:token|accessToken|idToken|refreshToken|authorization|credentials?|deviceSecret|idempotencyKey)$/iu;

function sources(): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(CATALOG_SOURCE)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => ({ name, text: readFileSync(join(CATALOG_SOURCE, name), "utf8") }));
}

/** Source code without comments, so prose such as "never credentials" is not mistaken for a leak. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

/** Every object key reachable from a value, with its path. */
function secretKeys(value: unknown, path = "$"): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(SECRET_KEY.test(key) ? [`${path}.${key}`] : []),
    ...secretKeys(child, `${path}.${key}`),
  ]);
}

describe("secret key detector", () => {
  it("matches exact secret identifiers and not names that merely contain them", () => {
    expect(secretKeys({ a: { token: "x" }, b: [{ credentials: {} }], Authorization: "y" })).toEqual([
      "$.a.token",
      "$.b.0.credentials",
      "$.Authorization",
    ]);
    expect(secretKeys({ credentialsCount: 1, tokenized: true, tokens_used: 0, phase: "ready" })).toEqual([]);
  });

  it("ignores comments but still sees code that names a credential", () => {
    const source = '/** never credentials */\n// no token here\nconst url = "http://x";\nrender(props.token);';
    expect(code(source)).not.toContain("never credentials");
    expect(code(source)).toContain('"http://x"');
    expect(code(source)).toMatch(/\btoken\b/u);
  });
});

describe("catalog credential boundary", () => {
  it("keeps no credential, token or idempotency key in the store or its snapshot", async () => {
    const api = registeredUserApi()
      .on(`GET ${BASE}/currency`, json(200, NGN))
      .on(`GET ${BASE}/catalog/units`, json(200, UNITS))
      .on(`GET ${BASE}/products`, json(200, { items: [productFixture()], nextCursor: null }))
      .on(`GET ${BASE}/categories`, json(200, { items: [categoryFixture()], nextCursor: null }))
      .on(`POST ${BASE}/categories`, json(201, categoryFixture({ name: "Snacks" })));
    const client = new TaliApiClient({
      baseUrl: "http://api.test",
      createCorrelationId: () => "c-1",
      fetch: api.fetch,
    });
    const session = new SessionStore({ api: client, newIdempotencyKey: newUuidV7 });
    await session.signInLocal("local-user-ada");
    session.selectBusiness(BUSINESS_A.id);
    const catalog = new CatalogStore({ businessId: BUSINESS_A.id, session, newIdempotencyKey: newUuidV7 });
    catalog.start();
    await settle();
    await catalog.createCategory({ name: "Snacks" });
    await settle();

    const key = api.to(`POST ${BASE}/categories`)[0]?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "";
    expect(key).not.toBe("");
    const serialized = JSON.stringify(catalog.getSnapshot());
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(key);
    expect(secretKeys(catalog.getSnapshot())).toEqual([]);
    expect(Object.keys(catalog)).toEqual(["subscribe", "getSnapshot"]);
    catalog.dispose();
  });

  it("catalog components never name a token, an Authorization header or a credential property", () => {
    const leaks = sources()
      .filter(({ name }) => name.endsWith(".tsx"))
      .flatMap(({ name, text }) =>
        [...code(text).matchAll(/\b(?:token|accessToken|idToken|refreshToken|Authorization|credentials)\b/gu)].map(
          (match) => `${name}: ${match[0]}`,
        ),
      );
    expect(leaks).toEqual([]);
  });

  it("the store holds no credential in a field and passes the callback credentials straight to the client", () => {
    const store = code(sources().find(({ name }) => name === "catalog-store.ts")?.text ?? "");
    expect(store).not.toMatch(/#\w*(?:token|credential)\w*/iu);
    expect(store).not.toMatch(/this\.\w+\s*=\s*(?:token|credentials)\b/u);
  });
});

describe("catalog source guards", () => {
  it("persists nothing, logs nothing and uses no floating-point money", () => {
    const forbidden: readonly [string, RegExp][] = [
      ["storage", /\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie/u],
      ["console", /\bconsole\./u],
      ["parseFloat", /\bparseFloat\(/u],
      ["Number()", /\bNumber\(/u],
      ["toFixed", /\.toFixed\(/u],
      ["Math", /\bMath\./u],
    ];
    const hits = sources().flatMap(({ name, text }) =>
      forbidden.filter(([, pattern]) => pattern.test(code(text))).map(([label]) => `${name}: ${label}`),
    );
    expect(hits).toEqual([]);
  });
});
