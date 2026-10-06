import { randomUUID } from "node:crypto";
import { readCatalogSnapshot, readTenancySnapshot, resetTenancyTables, tenancyFixtures } from "@tali/database/testing";
import { uuidV7IdGenerator } from "@tali/integrations/platform";
import {
  CategoriesResponseSchema,
  CategoryResponseSchema,
  ErrorEnvelopeSchema,
  type MembershipRoleWireSchema,
  PackResponseSchema,
  PacksResponseSchema,
  PriceHistoryResponseSchema,
  type ProductResponse,
  ProductResponseSchema,
  ProductsResponseSchema,
  UnitsResponseSchema,
} from "@tali/shared";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startApi, type ApiHarness } from "../support/api-harness.js";
import { bearer, createBusinessAs, registerActor, type RegisteredActor } from "../support/tenancy-client.js";

type Role = (typeof MembershipRoleWireSchema.options)[number];
const ROLES: readonly Role[] = ["OWNER", "MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"];
const MISSING_ID = "0190a000-0000-7000-8000-00000000dead";

const code = (body: unknown) => ErrorEnvelopeSchema.parse(body).error.code;

/** Keys that are storage or internal names and must never appear in a catalog response. */
const FORBIDDEN_KEYS = new Set([
  "normalized",
  "normalizedName",
  "skuNormalized",
  "barcodeNormalized",
  "sku_normalized",
  "barcode_normalized",
  "normalized_name",
  "businessId",
  "business_id",
  "createdByMembershipId",
  "isDefault",
  "is_default",
  "stockUnitCode",
  "stock_unit_code",
  "currentPriceMinor",
  "currentPriceCurrency",
  "current_price_minor",
  "factor_minor",
  "amount_minor",
  "variant",
  "variants",
  "product",
  "onHand",
  "quantityOnHand",
  "lowStockThreshold",
  "cost",
  "costPrice",
]);
const STRING_ONLY_KEYS = new Set(["amountMinor", "factorMinor", "quantityMinor"]);

/** Recursively checks a response body is wire-safe: string money and factors, no internal keys. */
function wireSafetyViolations(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => wireSafetyViolations(item, `${path}[${index}]`));
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? [`${path}: bigint`] : [];
  }
  return Object.entries(value).flatMap(([key, child]) => [
    ...(FORBIDDEN_KEYS.has(key) ? [`${path}.${key}: forbidden key`] : []),
    ...(STRING_ONLY_KEYS.has(key) && typeof child !== "string" ? [`${path}.${key}: not a string`] : []),
    ...wireSafetyViolations(child, `${path}.${key}`),
  ]);
}

describe("Build 2 Slice 3 catalog API over HTTP", () => {
  let api: ApiHarness;
  const http = () => request(api.app.getHttpServer());
  const seen: unknown[] = [];

  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api.close();
  });

  interface World {
    readonly a: string;
    readonly b: string;
    readonly actors: Readonly<Record<Role, RegisteredActor>>;
    readonly ownerB: RegisteredActor;
  }
  let world: World;

  beforeEach(async () => {
    await resetTenancyTables();
    const ownerA = await registerActor(api, `owner-a-${randomUUID()}`, "Amani");
    const ownerB = await registerActor(api, `owner-b-${randomUUID()}`, "Baraka");
    const a = (await createBusinessAs(api, ownerA, { name: "Duka A" })).business.id;
    const b = (await createBusinessAs(api, ownerB, { name: "Duka B" })).business.id;
    const actors: Partial<Record<Role, RegisteredActor>> = { OWNER: ownerA };
    for (const role of ROLES.filter((r) => r !== "OWNER")) {
      const actor = await registerActor(api, `${role.toLowerCase()}-${randomUUID()}`, role);
      await tenancyFixtures.insertMembership({
        id: uuidV7IdGenerator.newId("membership"),
        businessId: a,
        userId: actor.userId,
        role,
      });
      actors[role] = actor;
    }
    world = { a, b, ownerB, actors: actors as Record<Role, RegisteredActor> };
  });

  const as = (role: Role) => world.actors[role];
  const url = (businessId: string, path: string) => `/v1/businesses/${businessId}/${path}`;

  /** Every successful catalog body is collected and checked for wire safety at the end of each test. */
  function record<T>(body: T): T {
    seen.push(body);
    return body;
  }

  function createProduct(
    actor: RegisteredActor,
    body: Record<string, unknown> = {},
    key: string = randomUUID(),
    businessId = world.a,
  ) {
    return http()
      .post(url(businessId, "products"))
      .set(bearer(actor.token))
      .set("idempotency-key", key)
      .send({ name: "Peak Milk 400g", stockUnit: "PIECE", trackInventory: true, ...body });
  }

  async function product(body: Record<string, unknown> = {}, actor = as("OWNER")): Promise<ProductResponse> {
    const response = await createProduct(actor, body).expect(201);
    return record(ProductResponseSchema.parse(response.body));
  }

  function createCategory(actor: RegisteredActor, name: string, key: string = randomUUID()) {
    return http().post(url(world.a, "categories")).set(bearer(actor.token)).set("idempotency-key", key).send({ name });
  }

  function addPack(actor: RegisteredActor, productId: string, body: Record<string, unknown>, key = randomUUID()) {
    return http()
      .post(url(world.a, `products/${productId}/packs`))
      .set(bearer(actor.token))
      .set("idempotency-key", key)
      .send(body);
  }

  const get = (actor: RegisteredActor, path: string, businessId = world.a) =>
    http().get(url(businessId, path)).set(bearer(actor.token));

  beforeEach(() => {
    seen.length = 0;
  });

  describe("authentication, authorization and tenancy", () => {
    it("requires a bearer token on every catalog route", async () => {
      const item = await product();
      for (const [method, path] of [
        ["get", "products"],
        ["get", `products/${item.id}`],
        ["post", "products"],
        ["patch", `products/${item.id}`],
        ["put", `products/${item.id}/price`],
        ["get", "categories"],
        ["post", "categories"],
        ["get", `products/${item.id}/packs`],
        ["post", "packs/x/retire"],
        ["get", "catalog/units"],
      ] as const) {
        const response = await http()[method](url(world.a, path)).send({});
        expect({ path, status: response.status }).toEqual({ path, status: 401 });
        expect(code(response.body)).toBe("UNAUTHENTICATED");
      }
    });

    it("lets all five roles read products, categories, packs, prices and units", async () => {
      const item = await product();
      for (const role of ROLES) {
        const actor = as(role);
        record(ProductsResponseSchema.parse((await get(actor, "products").expect(200)).body));
        record(ProductResponseSchema.parse((await get(actor, `products/${item.id}`).expect(200)).body));
        record(PriceHistoryResponseSchema.parse((await get(actor, `products/${item.id}/prices`).expect(200)).body));
        record(PacksResponseSchema.parse((await get(actor, `products/${item.id}/packs`).expect(200)).body));
        record(CategoriesResponseSchema.parse((await get(actor, "categories").expect(200)).body));
        record(UnitsResponseSchema.parse((await get(actor, "catalog/units").expect(200)).body));
      }
    });

    it("denies roles without the mutation permission (403) and writes nothing", async () => {
      const item = await product();
      const pack = record(
        PackResponseSchema.parse((await addPack(as("OWNER"), item.id, { name: "Crate", factorMinor: "24" })).body),
      );
      const before = await readCatalogSnapshot();
      const denied = [
        () => createProduct(as("CASHIER")),
        () => createProduct(as("ACCOUNTANT")),
        () =>
          http()
            .patch(url(world.a, `products/${item.id}`))
            .set(bearer(as("CASHIER").token))
            .send({ expectedVersion: 1, name: "X" }),
        () =>
          http()
            .post(url(world.a, `products/${item.id}/archive`))
            .set(bearer(as("ACCOUNTANT").token))
            .send({ expectedVersion: 1 }),
        () =>
          http()
            .put(url(world.a, `products/${item.id}/price`))
            .set(bearer(as("STOCK_KEEPER").token))
            .send({ expectedVersion: 1, price: { amountMinor: "100", currency: "KES" } }),
        () => createCategory(as("CASHIER"), "Dairy"),
        () => addPack(as("ACCOUNTANT"), item.id, { name: "Box", factorMinor: "12" }),
        () =>
          http()
            .post(url(world.a, `packs/${pack.id}/retire`))
            .set(bearer(as("CASHIER").token)),
      ];
      for (const send of denied) {
        const response = await send();
        expect(response.status).toBe(403);
        expect(code(response.body)).toBe("PERMISSION_DENIED");
      }
      expect(await readCatalogSnapshot()).toEqual(before);
    });

    it("answers another business's catalog records with 404 and never changes them", async () => {
      const item = await product({ sku: "PK-400" });
      const category = record(
        CategoryResponseSchema.parse((await createCategory(as("OWNER"), "Dairy").expect(201)).body),
      );
      const pack = record(
        PackResponseSchema.parse((await addPack(as("OWNER"), item.id, { name: "Crate", factorMinor: "24" })).body),
      );
      const before = await readCatalogSnapshot();
      const b = world.b;
      const other = world.ownerB;
      const attempts = [
        () => get(other, `products/${item.id}`, b),
        () => get(other, `products/${item.id}/packs`, b),
        () => get(other, `products/${item.id}/prices`, b),
        () => get(other, `categories/${category.id}`, b),
        () =>
          http()
            .patch(url(b, `products/${item.id}`))
            .set(bearer(other.token))
            .send({ expectedVersion: 1, name: "Stolen" }),
        () =>
          http()
            .post(url(b, `products/${item.id}/archive`))
            .set(bearer(other.token))
            .send({ expectedVersion: 1 }),
        () =>
          http()
            .post(url(b, `products/${item.id}/reactivate`))
            .set(bearer(other.token))
            .send({ expectedVersion: 1 }),
        () =>
          http()
            .put(url(b, `products/${item.id}/price`))
            .set(bearer(other.token))
            .send({ expectedVersion: 1, price: { amountMinor: "100", currency: "KES" } }),
        () =>
          http()
            .post(url(b, `products/${item.id}/packs`))
            .set(bearer(other.token))
            .set("idempotency-key", randomUUID())
            .send({ name: "Box", factorMinor: "12" }),
        () =>
          http()
            .post(url(b, `packs/${pack.id}/retire`))
            .set(bearer(other.token)),
        () =>
          http()
            .patch(url(b, `categories/${category.id}`))
            .set(bearer(other.token))
            .send({ expectedVersion: 1, name: "X" }),
        () =>
          http()
            .post(url(b, `categories/${category.id}/archive`))
            .set(bearer(other.token))
            .send({ expectedVersion: 1 }),
        () => get(other, "products"),
        () => get(other, "catalog/units"),
      ];
      for (const send of attempts) {
        const response = await send();
        expect(response.status).toBe(404);
        expect(code(response.body)).toBe("NOT_FOUND");
      }
      for (const path of ["products", "products?q=PK-400", "categories", "products?status=ARCHIVED"]) {
        const body = (await get(other, path, b).expect(200)).body as { items: unknown[] };
        expect(body.items).toEqual([]);
      }
      expect((await createProduct(other, { categoryId: category.id }, randomUUID(), b).expect(404)).body).toMatchObject(
        { error: { code: "NOT_FOUND" } },
      );
      expect(await readCatalogSnapshot()).toEqual(before);
    });
  });

  describe("validation", () => {
    it("rejects unknown body and query fields, invalid statuses and malformed pages with 400", async () => {
      const item = await product();
      const failures = [
        () => createProduct(as("OWNER"), { businessId: world.b }),
        () => createProduct(as("OWNER"), { costPrice: { amountMinor: "1", currency: "KES" } }),
        () =>
          http()
            .patch(url(world.a, `products/${item.id}`))
            .set(bearer(as("OWNER").token))
            .send({ expectedVersion: 1, status: "ARCHIVED" }),
        () =>
          http()
            .patch(url(world.a, `products/${item.id}`))
            .set(bearer(as("OWNER").token))
            .send({ expectedVersion: 1 }),
        ...[
          "products?offset=10",
          "products?status=ALL",
          "products?status=active",
          "categories?status=RETIRED",
          `products/${item.id}/packs?status=ARCHIVED`,
          `products/${item.id}?expand=variant`,
          "catalog/units?limit=5",
          "products?limit=0",
          "products?limit=101",
          "products?after=not-a-cursor",
          "products?q=",
          "products?q=%20%20",
          "products?q=a&q=b",
        ].map((path) => () => get(as("OWNER"), path)),
      ];
      for (const send of failures) {
        const response = await send();
        expect({ status: response.status, code: code(response.body) }).toEqual({
          status: 400,
          code: "VALIDATION_FAILED",
        });
      }
    });

    it("answers malformed and unknown IDs with 404 NOT_FOUND", async () => {
      for (const path of [
        "products/not-a-uuid",
        `products/${MISSING_ID}`,
        "products/not-a-uuid/packs",
        "products/not-a-uuid/prices",
        "categories/not-a-uuid",
        `categories/${MISSING_ID}`,
      ]) {
        const response = await get(as("OWNER"), path).expect(404);
        expect(code(response.body)).toBe("NOT_FOUND");
      }
      const retire = await http()
        .post(url(world.a, "packs/not-a-uuid/retire"))
        .set(bearer(as("OWNER").token))
        .expect(404);
      expect(code(retire.body)).toBe("NOT_FOUND");
      const create = await createProduct(as("OWNER"), { categoryId: "not-a-uuid" }).expect(404);
      expect(code(create.body)).toBe("NOT_FOUND");
    });

    it("rejects invalid unit syntax at the boundary and unknown units in the application", async () => {
      for (const stockUnit of ["kg", "K1", "", 3]) {
        const response = await createProduct(as("OWNER"), { stockUnit }).expect(400);
        expect(code(response.body)).toBe("VALIDATION_FAILED");
      }
      const unknown = await createProduct(as("OWNER"), { stockUnit: "CARTON" }).expect(400);
      expect(ErrorEnvelopeSchema.parse(unknown.body).error).toMatchObject({ code: "VALIDATION_FAILED" });
      expect((await readCatalogSnapshot()).products).toEqual([]);
    });

    it("rejects JSON-number money and factors, with no coercion", async () => {
      const item = await product();
      expect(
        code(
          (await createProduct(as("OWNER"), { initialPrice: { amountMinor: 150000, currency: "KES" } }).expect(400))
            .body,
        ),
      ).toBe("VALIDATION_FAILED");
      const price = await http()
        .put(url(world.a, `products/${item.id}/price`))
        .set(bearer(as("OWNER").token))
        .send({ expectedVersion: 1, price: { amountMinor: 150000, currency: "KES" } })
        .expect(400);
      expect(code(price.body)).toBe("VALIDATION_FAILED");
      expect(code((await addPack(as("OWNER"), item.id, { name: "Crate", factorMinor: 24 }).expect(400)).body)).toBe(
        "VALIDATION_FAILED",
      );
      const version = await http()
        .patch(url(world.a, `products/${item.id}`))
        .set(bearer(as("OWNER").token))
        .send({ expectedVersion: "1", name: "X" })
        .expect(400);
      expect(code(version.body)).toBe("VALIDATION_FAILED");
      const snapshot = await readCatalogSnapshot();
      expect(snapshot.prices).toEqual([]);
      expect(snapshot.packs).toEqual([]);
    });

    it("requires an Idempotency-Key on every keyed create", async () => {
      const item = await product();
      for (const response of [
        await http()
          .post(url(world.a, "products"))
          .set(bearer(as("OWNER").token))
          .send({ name: "X", stockUnit: "PIECE", trackInventory: true }),
        await http()
          .post(url(world.a, "categories"))
          .set(bearer(as("OWNER").token))
          .send({ name: "X" }),
        await http()
          .post(url(world.a, `products/${item.id}/packs`))
          .set(bearer(as("OWNER").token))
          .send({ name: "X", factorMinor: "2" }),
      ]) {
        expect(response.status).toBe(400);
        expect(code(response.body)).toBe("IDEMPOTENCY_KEY_REQUIRED");
      }
    });
  });

  describe("products", () => {
    it("creates a schema-valid product with exactly one hidden default variant", async () => {
      const response = await createProduct(as("STOCK_KEEPER"), {
        name: "  Rice 50kg ",
        description: "Long grain",
        sku: " rice-50 ",
        barcode: "036000291452",
        stockUnit: "KG",
        trackInventory: false,
      }).expect(201);
      expect(response.headers["idempotent-replayed"]).toBeUndefined();
      const item = record(ProductResponseSchema.parse(response.body));
      expect(item).toMatchObject({
        name: "Rice 50kg",
        description: "Long grain",
        categoryId: null,
        status: "ACTIVE",
        version: 1,
        sku: "rice-50",
        barcode: "036000291452",
        stockUnit: "KG",
        trackInventory: false,
        sellingPrice: null,
        priceVersion: 0,
      });
      const snapshot = await readCatalogSnapshot();
      expect(snapshot.products).toHaveLength(1);
      expect(snapshot.variants).toEqual([
        {
          id: item.variantId,
          businessId: world.a,
          productId: item.id,
          isDefault: true,
          status: "ACTIVE",
          priceMinorText: null,
          priceVersion: 0,
        },
      ]);
      const audit = (await readTenancySnapshot()).businessAudit.filter((row) => row.action === "product.created");
      expect(audit).toHaveLength(1);
    });

    it("creates with an optional initial price as string minor units, which STOCK_KEEPER may not set", async () => {
      const priced = await product({ initialPrice: { amountMinor: "150000", currency: "KES" } });
      expect(priced).toMatchObject({ sellingPrice: { amountMinor: "150000", currency: "KES" }, priceVersion: 1 });
      const history = PriceHistoryResponseSchema.parse(
        (await get(as("OWNER"), `products/${priced.id}/prices`).expect(200)).body,
      );
      expect(history.items.map((row) => row.price)).toEqual([{ amountMinor: "150000", currency: "KES" }]);
      const before = await readCatalogSnapshot();
      const denied = await createProduct(as("STOCK_KEEPER"), { initialPrice: { amountMinor: "1", currency: "KES" } });
      expect(denied.status).toBe(403);
      expect(code(denied.body)).toBe("PERMISSION_DENIED");
      expect(await readCatalogSnapshot()).toEqual(before);
    });

    it("replays a keyed create with 201 and Idempotent-Replayed, and rejects a reused key (409)", async () => {
      const key = randomUUID();
      const first = await createProduct(as("OWNER"), { sku: "PK-1" }, key).expect(201);
      const replay = await createProduct(as("OWNER"), { sku: "PK-1" }, key).expect(201);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.body).toEqual(first.body);
      const reused = await createProduct(as("OWNER"), { sku: "PK-2" }, key).expect(409);
      expect(code(reused.body)).toBe("IDEMPOTENCY_KEY_REUSED");
      expect((await readCatalogSnapshot()).products).toHaveLength(1);
    });

    it("edits, no-ops, and rejects stale versions even for an unchanged state", async () => {
      const item = await product();
      const patch = (body: Record<string, unknown>) =>
        http()
          .patch(url(world.a, `products/${item.id}`))
          .set(bearer(as("MANAGER").token))
          .send(body);
      const edited = record(
        ProductResponseSchema.parse(
          (await patch({ expectedVersion: 1, name: "Peak Milk 800g", sku: "PK-800" }).expect(200)).body,
        ),
      );
      expect(edited).toMatchObject({ name: "Peak Milk 800g", sku: "PK-800", version: 2 });
      const noop = ProductResponseSchema.parse(
        (await patch({ expectedVersion: 2, name: "Peak Milk 800g" }).expect(200)).body,
      );
      expect(noop).toEqual(edited);
      const stale = await patch({ expectedVersion: 1, name: "Peak Milk 800g" }).expect(409);
      expect(code(stale.body)).toBe("VERSION_CONFLICT");
      const cleared = ProductResponseSchema.parse((await patch({ expectedVersion: 2, sku: null }).expect(200)).body);
      expect(cleared).toMatchObject({ sku: null, version: 3 });
      expect((await readCatalogSnapshot()).products[0]?.version).toBe(3);
    });

    it("archives and reactivates; archived products leave the default list but stay readable by ID", async () => {
      const item = await product({ barcode: "036000291452" });
      const archive = (version: number) =>
        http()
          .post(url(world.a, `products/${item.id}/archive`))
          .set(bearer(as("OWNER").token))
          .send({ expectedVersion: version, reason: "Discontinued" });
      const archived = record(ProductResponseSchema.parse((await archive(1).expect(200)).body));
      expect(archived).toMatchObject({ status: "ARCHIVED", version: 2 });
      expect(ProductResponseSchema.parse((await archive(2).expect(200)).body)).toEqual(archived);
      expect(ProductsResponseSchema.parse((await get(as("CASHIER"), "products").expect(200)).body).items).toEqual([]);
      expect(
        ProductsResponseSchema.parse((await get(as("CASHIER"), "products?status=ARCHIVED").expect(200)).body).items,
      ).toEqual([archived]);
      expect((await get(as("CASHIER"), `products/${item.id}`).expect(200)).body).toEqual(archived);

      const reactivated = await http()
        .post(url(world.a, `products/${item.id}/reactivate`))
        .set(bearer(as("OWNER").token))
        .send({ expectedVersion: 2 })
        .expect(200);
      expect(ProductResponseSchema.parse(reactivated.body)).toMatchObject({ status: "ACTIVE", version: 3 });
    });

    it("refuses to reactivate when an active product now holds the barcode (409 CONFLICT)", async () => {
      const item = await product({ barcode: "036000291452" });
      await http()
        .post(url(world.a, `products/${item.id}/archive`))
        .set(bearer(as("OWNER").token))
        .send({ expectedVersion: 1 })
        .expect(200);
      await product({ name: "Replacement", barcode: "0036000291452" });
      const conflict = await http()
        .post(url(world.a, `products/${item.id}/reactivate`))
        .set(bearer(as("OWNER").token))
        .send({ expectedVersion: 2 })
        .expect(409);
      expect(code(conflict.body)).toBe("CONFLICT");
      expect((await readCatalogSnapshot()).products.find((p) => p.id === item.id)?.status).toBe("ARCHIVED");
    });

    it("assigns and clears a category, and conflicts on a duplicate SKU", async () => {
      const category = record(
        CategoryResponseSchema.parse((await createCategory(as("OWNER"), "Dairy").expect(201)).body),
      );
      const item = await product({ categoryId: category.id, sku: "PK-1" });
      expect(item.categoryId).toBe(category.id);
      const duplicate = await createProduct(as("OWNER"), { name: "Other", sku: "pk-1" }).expect(409);
      expect(code(duplicate.body)).toBe("CONFLICT");
      const cleared = await http()
        .patch(url(world.a, `products/${item.id}`))
        .set(bearer(as("OWNER").token))
        .send({ expectedVersion: 1, categoryId: null })
        .expect(200);
      expect(ProductResponseSchema.parse(cleared.body).categoryId).toBeNull();
    });
  });

  describe("selling price", () => {
    it("sets, no-ops, rejects stale versions and foreign currencies, and lists history in string minor units", async () => {
      const item = await product();
      const put = (body: Record<string, unknown>, role: Role = "MANAGER") =>
        http()
          .put(url(world.a, `products/${item.id}/price`))
          .set(bearer(as(role).token))
          .send(body);
      const set = record(
        ProductResponseSchema.parse(
          (
            await put({
              expectedVersion: 1,
              price: { amountMinor: "150000", currency: "KES" },
              reason: "Launch",
            }).expect(200)
          ).body,
        ),
      );
      expect(set).toMatchObject({
        sellingPrice: { amountMinor: "150000", currency: "KES" },
        priceVersion: 1,
        version: 2,
      });
      const noop = await put({ expectedVersion: 2, price: { amountMinor: "150000", currency: "KES" } }).expect(200);
      expect(noop.body).toEqual(set);
      const stale = await put({ expectedVersion: 1, price: { amountMinor: "150000", currency: "KES" } }).expect(409);
      expect(code(stale.body)).toBe("VERSION_CONFLICT");
      for (const price of [
        { amountMinor: "150000", currency: "NGN" },
        { amountMinor: "0", currency: "KES" },
        { amountMinor: "-5", currency: "KES" },
      ]) {
        expect(code((await put({ expectedVersion: 2, price }).expect(400)).body)).toBe("VALIDATION_FAILED");
      }
      await put({ expectedVersion: 2, price: { amountMinor: "9223372036854775807", currency: "KES" } }, "OWNER").expect(
        200,
      );
      const history = record(
        PriceHistoryResponseSchema.parse((await get(as("ACCOUNTANT"), `products/${item.id}/prices`).expect(200)).body),
      );
      expect(history.items.map((row) => [row.priceVersion, row.price.amountMinor, row.reason])).toEqual([
        [1, "150000", "Launch"],
        [2, "9223372036854775807", null],
      ]);
      expect(history.items.every((row) => row.variantId === item.variantId)).toBe(true);
      expect((await readCatalogSnapshot()).prices.map((row) => row.amountText)).toEqual([
        "150000",
        "9223372036854775807",
      ]);
    });
  });

  describe("categories", () => {
    it("creates, replays, renames, archives, lists by status and conflicts on an active duplicate name", async () => {
      const key = randomUUID();
      const created = await createCategory(as("STOCK_KEEPER"), "Dairy", key).expect(201);
      const category = record(CategoryResponseSchema.parse(created.body));
      expect(category).toMatchObject({ name: "Dairy", status: "ACTIVE", version: 1 });
      const replay = await createCategory(as("STOCK_KEEPER"), "Dairy", key).expect(201);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.body).toEqual(created.body);
      expect(code((await createCategory(as("STOCK_KEEPER"), "Drinks", key).expect(409)).body)).toBe(
        "IDEMPOTENCY_KEY_REUSED",
      );
      expect(code((await createCategory(as("OWNER"), "dairy").expect(409)).body)).toBe("CONFLICT");

      const patch = (body: Record<string, unknown>) =>
        http()
          .patch(url(world.a, `categories/${category.id}`))
          .set(bearer(as("OWNER").token))
          .send(body);
      const renamed = CategoryResponseSchema.parse(
        (await patch({ expectedVersion: 1, name: "Milk" }).expect(200)).body,
      );
      expect(renamed).toMatchObject({ name: "Milk", version: 2 });
      expect(code((await patch({ expectedVersion: 1, name: "Milk" }).expect(409)).body)).toBe("VERSION_CONFLICT");
      const other = record(
        CategoryResponseSchema.parse((await createCategory(as("OWNER"), "Snacks").expect(201)).body),
      );
      const archived = await http()
        .post(url(world.a, `categories/${category.id}/archive`))
        .set(bearer(as("OWNER").token))
        .send({ expectedVersion: 2 })
        .expect(200);
      expect(CategoryResponseSchema.parse(archived.body)).toMatchObject({ status: "ARCHIVED", version: 3 });

      const active = CategoriesResponseSchema.parse((await get(as("CASHIER"), "categories").expect(200)).body);
      expect(active.items.map((c) => c.id)).toEqual([other.id]);
      const gone = CategoriesResponseSchema.parse(
        (await get(as("CASHIER"), "categories?status=ARCHIVED").expect(200)).body,
      );
      expect(gone.items.map((c) => c.id)).toEqual([category.id]);
      expect(
        CategoryResponseSchema.parse((await get(as("CASHIER"), `categories/${category.id}`).expect(200)).body).status,
      ).toBe("ARCHIVED");
      record(active);
      record(gone);
    });
  });

  describe("packs", () => {
    it("adds with a string factor, replays, lists, retires idempotently and conflicts on an active duplicate", async () => {
      const item = await product({ stockUnit: "KG" });
      const key = randomUUID();
      const added = await addPack(
        as("STOCK_KEEPER"),
        item.id,
        { name: "Bag of 50 kg", factorMinor: "50000" },
        key,
      ).expect(201);
      const pack = record(PackResponseSchema.parse(added.body));
      expect(pack).toMatchObject({
        variantId: item.variantId,
        name: "Bag of 50 kg",
        factorMinor: "50000",
        status: "ACTIVE",
      });
      const replay = await addPack(
        as("STOCK_KEEPER"),
        item.id,
        { name: "Bag of 50 kg", factorMinor: "50000" },
        key,
      ).expect(201);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.body).toEqual(added.body);
      expect(
        code(
          (await addPack(as("STOCK_KEEPER"), item.id, { name: "Bag of 25 kg", factorMinor: "25000" }, key).expect(409))
            .body,
        ),
      ).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(
        code((await addPack(as("OWNER"), item.id, { name: "Bag of 50 kg", factorMinor: "50000" }).expect(409)).body),
      ).toBe("CONFLICT");
      for (const factorMinor of ["1", "1000000001"]) {
        expect(code((await addPack(as("OWNER"), item.id, { name: "Odd", factorMinor }).expect(400)).body)).toBe(
          "VALIDATION_FAILED",
        );
      }

      const listed = PacksResponseSchema.parse(
        (await get(as("CASHIER"), `products/${item.id}/packs`).expect(200)).body,
      );
      expect(listed.items).toEqual([pack]);
      const retire = () =>
        http()
          .post(url(world.a, `packs/${pack.id}/retire`))
          .set(bearer(as("OWNER").token));
      const retired = record(PackResponseSchema.parse((await retire().expect(200)).body));
      expect(retired).toMatchObject({ id: pack.id, status: "RETIRED", factorMinor: "50000" });
      expect((await retire().expect(200)).body).toEqual(retired);
      expect(code((await retire().send({ reason: "x" }).expect(400)).body)).toBe("VALIDATION_FAILED");
      expect(
        PacksResponseSchema.parse((await get(as("CASHIER"), `products/${item.id}/packs`).expect(200)).body).items,
      ).toEqual([]);
      expect(
        PacksResponseSchema.parse(
          (await get(as("CASHIER"), `products/${item.id}/packs?status=RETIRED`).expect(200)).body,
        ).items,
      ).toEqual([retired]);
      expect((await readCatalogSnapshot()).packs.map((row) => row.factorText)).toEqual(["50000"]);
    });
  });

  describe("search", () => {
    it("matches name containment, normalized SKU and GTIN-equivalent barcodes within the business", async () => {
      const milk = await product({ name: "Peak Milk 400g", sku: "pk-400" });
      const rice = await product({ name: "Rice 50kg", barcode: "036000291452" });
      await product({ name: "100% Juice" });
      await createProduct(world.ownerB, { name: "Peak Milk 400g", sku: "PK-400" }, randomUUID(), world.b).expect(201);
      const search = async (q: string) =>
        ProductsResponseSchema.parse(
          (await get(as("CASHIER"), `products?q=${encodeURIComponent(q)}`).expect(200)).body,
        ).items.map((item) => item.name);
      expect(await search("milk")).toEqual(["Peak Milk 400g"]);
      expect(await search("PEAK")).toEqual(["Peak Milk 400g"]);
      expect(await search("PK-400")).toEqual(["Peak Milk 400g"]);
      expect(await search(" pk-400 ")).toEqual(["Peak Milk 400g"]);
      expect(await search("036000291452")).toEqual(["Rice 50kg"]);
      expect(await search("00036000291452")).toEqual(["Rice 50kg"]);
      expect(await search("%")).toEqual(["100% Juice"]);
      expect(await search("_")).toEqual([]);
      expect(await search("Milk & honey")).toEqual([]);
      expect(await search("ø")).toEqual([]);
      const archived = await http()
        .post(url(world.a, `products/${milk.id}/archive`))
        .set(bearer(as("OWNER").token))
        .send({ expectedVersion: 1 })
        .expect(200);
      expect(await search("PK-400")).toEqual([]);
      const inArchive = ProductsResponseSchema.parse(
        (await get(as("CASHIER"), "products?status=ARCHIVED&q=pk-400").expect(200)).body,
      );
      expect(inArchive.items).toEqual([archived.body]);
      expect(rice.barcode).toBe("036000291452");
    });
  });

  describe("units and pagination", () => {
    it("lists exactly the nine approved units with kind and scale", async () => {
      const units = record(UnitsResponseSchema.parse((await get(as("ACCOUNTANT"), "catalog/units").expect(200)).body));
      expect(units.items).toHaveLength(9);
      expect(new Map(units.items.map((u) => [u.code, `${u.kind}/${String(u.scale)}`]))).toEqual(
        new Map([
          ["BOTTLE", "COUNT/0"],
          ["G", "MASS/0"],
          ["KG", "MASS/3"],
          ["L", "VOLUME/3"],
          ["ML", "VOLUME/0"],
          ["PACK", "COUNT/0"],
          ["PIECE", "COUNT/0"],
          ["SACHET", "COUNT/0"],
          ["TIN", "COUNT/0"],
        ]),
      );
    });

    it("pages products by keyset with { items, nextCursor }", async () => {
      const ids: string[] = [];
      for (const name of ["A", "B", "C"]) ids.push((await product({ name })).id);
      ids.sort();
      const first = record(ProductsResponseSchema.parse((await get(as("OWNER"), "products?limit=2").expect(200)).body));
      expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
      expect(first.nextCursor).toBe(ids[1]);
      const second = ProductsResponseSchema.parse(
        (await get(as("OWNER"), `products?limit=2&after=${first.nextCursor ?? ""}`).expect(200)).body,
      );
      expect(second.items.map((item) => item.id)).toEqual(ids.slice(2));
      expect(second.nextCursor).toBeNull();
      const defaults = ProductsResponseSchema.parse((await get(as("OWNER"), "products").expect(200)).body);
      expect(defaults).toEqual({ items: expect.any(Array) as unknown, nextCursor: null });
    });
  });

  describe("wire safety", () => {
    it("never exposes JSON-number money or factors, normalized keys or storage names", async () => {
      const category = record(
        CategoryResponseSchema.parse((await createCategory(as("OWNER"), "Dairy").expect(201)).body),
      );
      const item = await product({
        categoryId: category.id,
        sku: "pk-1",
        barcode: "036000291452",
        initialPrice: { amountMinor: "9223372036854775807", currency: "KES" },
      });
      await addPack(as("OWNER"), item.id, { name: "Crate", factorMinor: "24" }).expect(201);
      for (const path of [
        "products",
        `products/${item.id}`,
        `products/${item.id}/prices`,
        `products/${item.id}/packs`,
        "categories",
        `categories/${category.id}`,
        "catalog/units",
      ]) {
        const response = await get(as("CASHIER"), path).expect(200);
        record(response.body);
        expect(response.text).not.toMatch(/"(amountMinor|factorMinor|quantityMinor)":\s*-?\d/);
        expect(response.text).not.toMatch(/normaliz/i);
        expect(response.text).not.toMatch(/_id"|"PK-1"|00036000291452/);
      }
      expect(seen.flatMap((body) => wireSafetyViolations(body))).toEqual([]);
    });
  });
});
