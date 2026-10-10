import { randomUUID } from "node:crypto";
import { readInventoryConsistency, readInventorySnapshot } from "@tali/database/testing";
import {
  CancelStocktakeResponseSchema,
  DEVICE_CREDENTIAL_HEADER,
  DEVICE_ID_HEADER,
  InventoryItemResponseSchema,
  InventoryMovementsResponseSchema,
  PostStocktakeResponseSchema,
  RegisterDeviceResponseSchema,
  type StocktakeCreationResponse,
  StocktakeCreationResponseSchema,
  type StocktakeLineChangeResponse,
  StocktakeLineChangeResponseSchema,
  StocktakeLinesResponseSchema,
  StocktakeResponseSchema,
  StocktakesResponseSchema,
  StocktakeStaleDetailsSchema,
  StocktakeStaleErrorEnvelopeSchema,
} from "@tali/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ApiHarness, startApi } from "../support/api-harness.js";
import {
  code,
  FORBIDDEN_INVENTORY_KEYS,
  type InventoryWorld,
  inventoryClient,
  inventoryWorld,
  keysDeep,
  MISSING_ID,
  nonStringQuantities,
  type Role,
  type StockItem,
} from "../support/inventory-client.js";
import { bearer, type RegisteredActor } from "../support/tenancy-client.js";

const FULL_ONLY_KEYS = ["expectedAtCount", "variance"];

describe("Build 2 Slice 6 stocktake API over HTTP", () => {
  let api: ApiHarness;
  let world: InventoryWorld;
  const seen: unknown[] = [];
  const client = () => inventoryClient(api, () => world);

  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(async () => {
    world = await inventoryWorld(api);
  });
  afterEach(async () => {
    for (const body of seen.splice(0)) {
      const keys = keysDeep(body);
      expect(FORBIDDEN_INVENTORY_KEYS.filter((key) => keys.has(key))).toEqual([]);
      expect(nonStringQuantities(body)).toEqual([]);
    }
    expect(await readInventoryConsistency()).toEqual([]);
  });

  function record<T>(body: T): T {
    seen.push(body);
    return body;
  }

  const as = (role: Role) => world.actors[role];
  const pieces = (quantityMinor: string) => ({ quantityMinor, unit: "PIECE" });
  const stocktakePath = (id: string, rest = "") => `inventory/stocktakes/${id}${rest}`;

  async function create(
    actor: RegisteredActor = as("OWNER"),
    body: Record<string, unknown> = {},
    key = randomUUID(),
  ): Promise<StocktakeCreationResponse> {
    const response = await client().keyed("inventory/stocktakes", body, actor, key).expect(201);
    return record(StocktakeCreationResponseSchema.parse(response.body));
  }

  async function count(
    stocktakeId: string,
    stock: StockItem,
    body: Record<string, unknown>,
    actor: RegisteredActor = as("OWNER"),
  ): Promise<StocktakeLineChangeResponse> {
    const response = await client().put(stocktakePath(stocktakeId, `/lines/${stock.variantId}`), body, actor);
    expect({ status: response.status, body: response.body as unknown }).toMatchObject({ status: 200 });
    return record(StocktakeLineChangeResponseSchema.parse(response.body));
  }

  async function current(stocktakeId: string): Promise<number> {
    const response = await client().get(stocktakePath(stocktakeId)).expect(200);
    return StocktakeResponseSchema.parse(response.body).version;
  }

  async function onHand(stock: StockItem): Promise<string> {
    const response = await client().get(`inventory/items/${stock.variantId}`).expect(200);
    return InventoryItemResponseSchema.parse(response.body).onHand.quantityMinor;
  }

  describe("creating", () => {
    it("lets OWNER, MANAGER and STOCK_KEEPER start a DRAFT and denies CASHIER and ACCOUNTANT", async () => {
      for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
        const response = await client().keyed("inventory/stocktakes", {}, as(role)).expect(403);
        expect(code(response.body)).toBe("PERMISSION_DENIED");
      }
      for (const role of ["OWNER", "MANAGER", "STOCK_KEEPER"] as const) {
        const created = await create(as(role), { note: `${role} count` });
        expect(created).toMatchObject({ status: "DRAFT", version: 1, note: `${role} count` });
        await client().post(stocktakePath(created.stocktakeId, "/cancel"), { expectedVersion: 1 }).expect(200);
      }
      expect((await readInventorySnapshot()).stocktakes).toHaveLength(3);
    });

    it("accepts an absent body, requires a key and rejects a client location", async () => {
      const missing = await client().keyed("inventory/stocktakes", {}, as("OWNER"), null).expect(400);
      expect(code(missing.body)).toBe("IDEMPOTENCY_KEY_REQUIRED");
      const located = await client().keyed("inventory/stocktakes", { locationId: MISSING_ID }).expect(400);
      expect(code(located.body)).toBe("VALIDATION_FAILED");
      const bare = await client()
        .http()
        .post(`/v1/businesses/${world.a}/inventory/stocktakes`)
        .set(bearer(as("OWNER").token))
        .set("idempotency-key", randomUUID())
        .expect(201);
      expect(record(StocktakeCreationResponseSchema.parse(bare.body))).toMatchObject({ status: "DRAFT", note: null });
    });

    it("replays the DRAFT version-1 creation snapshot, even after the stocktake is POSTED", async () => {
      const milk = await client().product();
      const key = randomUUID();
      const first = await client().keyed("inventory/stocktakes", { note: "Monthly" }, as("OWNER"), key).expect(201);
      expect(first.headers["idempotent-replayed"]).toBeUndefined();
      const created = record(StocktakeCreationResponseSchema.parse(first.body));
      const counted = await count(created.stocktakeId, milk, { count: pieces("0") });
      await client()
        .post(stocktakePath(created.stocktakeId, "/post"), { expectedVersion: counted.stocktake.version })
        .expect(200);
      const replay = await client().keyed("inventory/stocktakes", { note: "Monthly" }, as("OWNER"), key).expect(201);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.body).toEqual(first.body);
      expect(replay.body).toMatchObject({ status: "DRAFT", version: 1 });
      const reused = await client().keyed("inventory/stocktakes", { note: "Other" }, as("OWNER"), key).expect(409);
      expect(code(reused.body)).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("rejects a second DRAFT at the location with 409 CONFLICT whatever the key", async () => {
      await create();
      const second = await client().keyed("inventory/stocktakes", {}, as("MANAGER")).expect(409);
      expect(code(second.body)).toBe("CONFLICT");
      expect((await readInventorySnapshot()).stocktakes).toHaveLength(1);
    });
  });

  describe("reading", () => {
    it("shows FULL to OWNER and MANAGER, BLIND to STOCK_KEEPER, and nothing to CASHIER or ACCOUNTANT", async () => {
      const milk = await client().product();
      await client().receive([[milk, "10"]]);
      const created = await create();
      await count(created.stocktakeId, milk, { count: pieces("7") });
      const reads = [
        "inventory/stocktakes",
        stocktakePath(created.stocktakeId),
        stocktakePath(created.stocktakeId, "/lines"),
      ];
      for (const role of ["OWNER", "MANAGER"] as const) {
        const list = record(
          StocktakesResponseSchema.parse(
            (
              await client()
                .get(reads[0] ?? "", as(role))
                .expect(200)
            ).body,
          ),
        );
        expect(list.items.map((stocktake) => stocktake.visibility)).toEqual(["FULL"]);
        const lines = record(
          StocktakeLinesResponseSchema.parse(
            (
              await client()
                .get(reads[2] ?? "", as(role))
                .expect(200)
            ).body,
          ),
        );
        expect(lines.items).toEqual([
          expect.objectContaining({ visibility: "FULL", expectedAtCount: pieces("10"), variance: null }),
        ]);
      }
      for (const path of reads) {
        const response = await client().get(path, as("STOCK_KEEPER")).expect(200);
        record(response.body);
        const keys = keysDeep(response.body);
        expect({ path, leaked: FULL_ONLY_KEYS.filter((key) => keys.has(key)) }).toEqual({ path, leaked: [] });
        expect(JSON.stringify(response.body)).toContain('"visibility":"BLIND"');
        expect(JSON.stringify(response.body)).not.toContain('"visibility":"FULL"');
      }
      for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
        for (const path of reads) {
          expect(code((await client().get(path, as(role)).expect(403)).body)).toBe("PERMISSION_DENIED");
        }
      }
    });

    it("keeps summary counts in BLIND headers and filters the list by status", async () => {
      const milk = await client().product();
      const created = await create();
      await count(created.stocktakeId, milk, { count: pieces("2") });
      const blind = StocktakeResponseSchema.parse(
        (await client().get(stocktakePath(created.stocktakeId), as("STOCK_KEEPER")).expect(200)).body,
      );
      expect(blind).toMatchObject({ visibility: "BLIND", countedLineCount: 1, posting: null });
      const drafts = StocktakesResponseSchema.parse(
        (await client().get("inventory/stocktakes?status=DRAFT").expect(200)).body,
      );
      expect(drafts.items.map((stocktake) => stocktake.stocktakeId)).toEqual([created.stocktakeId]);
      const posted = StocktakesResponseSchema.parse(
        (await client().get("inventory/stocktakes?status=POSTED").expect(200)).body,
      );
      expect(posted.items).toEqual([]);
      expect(code((await client().get("inventory/stocktakes?status=OPEN").expect(400)).body)).toBe("VALIDATION_FAILED");
    });

    it("answers 404 for malformed, unknown and other-tenant stocktakes", async () => {
      const foreign = StocktakeCreationResponseSchema.parse(
        (await client().keyed("inventory/stocktakes", {}, world.ownerB, randomUUID(), world.b).expect(201)).body,
      );
      for (const id of ["not-a-uuid", MISSING_ID, foreign.stocktakeId]) {
        for (const rest of ["", "/lines"]) {
          expect(code((await client().get(stocktakePath(id, rest)).expect(404)).body)).toBe("NOT_FOUND");
        }
      }
    });
  });

  describe("counting", () => {
    it("records direct, zero, decimal, pack and pack-plus-loose counts without moving stock", async () => {
      const milk = await client().product();
      const zero = await client().product();
      const rice = await client().product({ name: "Rice", stockUnit: "KG" });
      const soda = await client().product();
      const crate = await client().pack(soda, "24");
      await client().receive([[milk, "10"]]);
      const before = (await readInventorySnapshot()).movements;
      const created = await create();
      const id = created.stocktakeId;
      expect((await count(id, milk, { count: pieces("12") })).line.countedQuantity).toEqual(pieces("12"));
      expect((await count(id, zero, { count: pieces("0"), expectedVersion: 0 })).line.countedQuantity).toEqual(
        pieces("0"),
      );
      expect((await count(id, rice, { count: { decimal: "1.5", unit: "KG" } })).line.countedQuantity).toEqual({
        quantityMinor: "1500",
        unit: "KG",
      });
      const packed = await count(id, soda, { count: { packId: crate, packCount: "2" } });
      expect(packed.line.countedQuantity).toEqual(pieces("48"));
      const loose = await count(id, soda, {
        count: { packId: crate, packCount: "2", loose: pieces("5") },
        expectedVersion: packed.line.version,
      });
      expect(loose.line).toMatchObject({ countedQuantity: pieces("53"), version: packed.line.version + 1 });
      expect(loose.stocktake).toMatchObject({ status: "DRAFT", countedLineCount: 4 });
      expect((await readInventorySnapshot()).movements).toEqual(before);
      expect(await onHand(milk)).toBe("10");
    });

    it("requires the line version to recount: omitted or 0 is VERSION_CONFLICT, a malformed one is 400", async () => {
      const milk = await client().product();
      const id = (await create()).stocktakeId;
      const first = await count(id, milk, { count: pieces("3") });
      const path = stocktakePath(id, `/lines/${milk.variantId}`);
      for (const body of [
        { count: pieces("4") },
        { count: pieces("4"), expectedVersion: 0 },
        { count: pieces("4"), expectedVersion: 9 },
      ]) {
        expect(code((await client().put(path, body).expect(409)).body)).toBe("VERSION_CONFLICT");
      }
      for (const expectedVersion of [-1, 1.5, "1", null]) {
        expect(
          code(
            (
              await client()
                .put(path, { count: pieces("4"), expectedVersion })
                .expect(400)
            ).body,
          ),
        ).toBe("VALIDATION_FAILED");
      }
      for (const countBody of [
        { quantityMinor: 4, unit: "PIECE" },
        { quantityMinor: "-1", unit: "PIECE" },
        { unit: "PIECE" },
      ]) {
        expect(code((await client().put(path, { count: countBody }).expect(400)).body)).toBe("VALIDATION_FAILED");
      }
      const recount = await count(id, milk, { count: pieces("4"), expectedVersion: first.line.version });
      expect(recount.line).toMatchObject({ countedQuantity: pieces("4"), version: first.line.version + 1 });
    });

    it("rejects retired (409) and foreign (404) packs, untracked products and archived products without stock", async () => {
      const soda = await client().product();
      const other = await client().product();
      const retired = await client().pack(soda, "6");
      await client().retirePack(retired);
      const foreignPack = await client().pack(other, "12");
      const untracked = await client().product({ trackInventory: false });
      const archivedEmpty = await client().product();
      await client().archive(archivedEmpty);
      const archivedStocked = await client().product();
      await client().receive([[archivedStocked, "4"]]);
      await client().archive(archivedStocked);
      const id = (await create()).stocktakeId;
      const put = (stock: StockItem, body: unknown) =>
        client().put(stocktakePath(id, `/lines/${stock.variantId}`), body);

      expect(code((await put(soda, { count: { packId: retired, packCount: "1" } }).expect(409)).body)).toBe("CONFLICT");
      expect(code((await put(soda, { count: { packId: foreignPack, packCount: "1" } }).expect(404)).body)).toBe(
        "NOT_FOUND",
      );
      expect(code((await put(untracked, { count: pieces("1") }).expect(409)).body)).toBe("CONFLICT");
      expect(code((await put(archivedEmpty, { count: pieces("1") }).expect(409)).body)).toBe("CONFLICT");
      expect((await count(id, archivedStocked, { count: pieces("4") })).line.countedQuantity).toEqual(pieces("4"));
      for (const variantId of ["not-a-uuid", MISSING_ID]) {
        const response = await client()
          .put(stocktakePath(id, `/lines/${variantId}`), { count: pieces("1") })
          .expect(404);
        expect(code(response.body)).toBe("NOT_FOUND");
      }
    });
  });

  describe("removing a line", () => {
    it("marks a counted line REMOVED, state-settingly, and 404s an uncounted one", async () => {
      const milk = await client().product();
      const sugar = await client().product();
      const id = (await create()).stocktakeId;
      const counted = await count(id, milk, { count: pieces("3") });
      const path = stocktakePath(id, `/lines/${milk.variantId}/remove`);
      const removed = record(
        StocktakeLineChangeResponseSchema.parse(
          (await client().post(path, { expectedVersion: counted.line.version }).expect(200)).body,
        ),
      );
      expect(removed).toMatchObject({ changed: true, line: { status: "REMOVED" }, stocktake: { countedLineCount: 0 } });
      const again = StocktakeLineChangeResponseSchema.parse(
        (await client().post(path, { expectedVersion: removed.line.version }).expect(200)).body,
      );
      expect(again).toMatchObject({ changed: false, line: { status: "REMOVED", version: removed.line.version } });
      expect(code((await client().post(path, { expectedVersion: 0 }).expect(400)).body)).toBe("VALIDATION_FAILED");
      const missing = await client()
        .post(stocktakePath(id, `/lines/${sugar.variantId}/remove`), { expectedVersion: 1 })
        .expect(404);
      expect(code(missing.body)).toBe("NOT_FOUND");
    });
  });

  describe("posting", () => {
    it("posts mixed variances as COUNT_CORRECTION movements with a summary, and re-posting is a no-op", async () => {
      const over = await client().product();
      const under = await client().product();
      const exact = await client().product();
      await client().receive([
        [over, "10"],
        [under, "10"],
        [exact, "10"],
      ]);
      const id = (await create()).stocktakeId;
      await count(id, over, { count: pieces("13") });
      await count(id, under, { count: pieces("6") });
      const last = await count(id, exact, { count: pieces("10") });
      const denied = await client()
        .post(stocktakePath(id, "/post"), { expectedVersion: last.stocktake.version }, as("STOCK_KEEPER"))
        .expect(403);
      expect(code(denied.body)).toBe("PERMISSION_DENIED");

      const body = { expectedVersion: last.stocktake.version };
      const posted = record(
        PostStocktakeResponseSchema.parse((await client().post(stocktakePath(id, "/post"), body).expect(200)).body),
      );
      expect(posted.changed).toBe(true);
      expect(posted.stocktake).toMatchObject({
        visibility: "FULL",
        status: "POSTED",
        countedLineCount: 3,
        posting: { correctionMovementCount: 2, zeroVarianceCount: 1 },
      });
      expect(posted.stocktake.postedAt).not.toBeNull();
      expect(posted.stocktake.businessDate).not.toBeNull();
      const byVariant = new Map(posted.movements.map((movement) => [movement.variantId, movement]));
      expect(byVariant.get(over.variantId)).toMatchObject({
        type: "COUNT_CORRECTION",
        delta: pieces("3"),
        balanceAfter: pieces("13"),
        source: { kind: "STOCKTAKE", id },
      });
      expect(byVariant.get(under.variantId)).toMatchObject({ type: "COUNT_CORRECTION", delta: pieces("-4") });
      expect(byVariant.has(exact.variantId)).toBe(false);
      expect([await onHand(over), await onHand(under), await onHand(exact)]).toEqual(["13", "6", "10"]);

      const history = InventoryMovementsResponseSchema.parse(
        (await client().get(`inventory/items/${under.variantId}/movements`).expect(200)).body,
      );
      expect(history.items[0]).toMatchObject({ type: "COUNT_CORRECTION", source: { kind: "STOCKTAKE", id } });

      const lines = StocktakeLinesResponseSchema.parse(
        (await client().get(stocktakePath(id, "/lines")).expect(200)).body,
      );
      expect(lines.items.map((line) => (line.visibility === "FULL" ? line.variance : undefined))).toEqual(
        expect.arrayContaining([pieces("3"), pieces("-4"), pieces("0")]),
      );

      const movements = (await readInventorySnapshot()).movements.length;
      const retry = PostStocktakeResponseSchema.parse(
        (await client().post(stocktakePath(id, "/post"), body).expect(200)).body,
      );
      expect(retry).toMatchObject({ changed: false, movements: [], stocktake: posted.stocktake });
      expect((await readInventorySnapshot()).movements).toHaveLength(movements);
    });

    it("answers STOCKTAKE_STALE with schema-valid details when stock moved after counting, and posts nothing", async () => {
      const milk = await client().product();
      const sugar = await client().product();
      await client().receive([
        [milk, "5"],
        [sugar, "5"],
      ]);
      const id = (await create()).stocktakeId;
      await count(id, milk, { count: pieces("4") });
      const last = await count(id, sugar, { count: pieces("5") });
      await client().receive([[milk, "1"]]);
      const before = await readInventorySnapshot();
      const response = await client()
        .post(stocktakePath(id, "/post"), { expectedVersion: last.stocktake.version })
        .expect(409);
      const envelope = StocktakeStaleErrorEnvelopeSchema.parse(response.body);
      expect(StocktakeStaleDetailsSchema.parse(envelope.error.details)).toEqual({
        staleVariantIds: [milk.variantId],
        staleLineCount: 1,
      });
      expect(Object.keys(envelope.error.details).sort()).toEqual(["staleLineCount", "staleVariantIds"]);
      expect(await readInventorySnapshot()).toEqual(before);
      expect(await current(id)).toBe(last.stocktake.version);
    });

    it("validates the post version", async () => {
      const id = (await create()).stocktakeId;
      for (const expectedVersion of [0, -1, "1", 1.5]) {
        const response = await client().post(stocktakePath(id, "/post"), { expectedVersion }).expect(400);
        expect(code(response.body)).toBe("VALIDATION_FAILED");
      }
      expect(code((await client().post(stocktakePath(id, "/post"), { expectedVersion: 7 }).expect(409)).body)).toBe(
        "VERSION_CONFLICT",
      );
    });
  });

  describe("cancelling", () => {
    it("cancels a DRAFT without moving stock, is a no-op when repeated, and cannot cancel a POSTED stocktake", async () => {
      const milk = await client().product();
      await client().receive([[milk, "5"]]);
      const id = (await create()).stocktakeId;
      const counted = await count(id, milk, { count: pieces("1") });
      const before = (await readInventorySnapshot()).movements;
      const body = { expectedVersion: counted.stocktake.version, reason: "Started by mistake" };
      const denied = await client().post(stocktakePath(id, "/cancel"), body, as("STOCK_KEEPER")).expect(403);
      expect(code(denied.body)).toBe("PERMISSION_DENIED");
      const cancelled = record(
        CancelStocktakeResponseSchema.parse((await client().post(stocktakePath(id, "/cancel"), body).expect(200)).body),
      );
      expect(cancelled).toMatchObject({ changed: true, stocktake: { status: "CANCELLED", visibility: "FULL" } });
      expect(cancelled.stocktake.cancelledAt).not.toBeNull();
      const again = CancelStocktakeResponseSchema.parse(
        (await client().post(stocktakePath(id, "/cancel"), body).expect(200)).body,
      );
      expect(again).toMatchObject({ changed: false, stocktake: cancelled.stocktake });
      expect((await readInventorySnapshot()).movements).toEqual(before);
      expect(await onHand(milk)).toBe("5");

      const next = await create();
      const nextCounted = await count(next.stocktakeId, milk, { count: pieces("5") });
      await client()
        .post(stocktakePath(next.stocktakeId, "/post"), { expectedVersion: nextCounted.stocktake.version })
        .expect(200);
      const posted = await current(next.stocktakeId);
      const late = await client()
        .post(stocktakePath(next.stocktakeId, "/cancel"), { expectedVersion: posted })
        .expect(409);
      expect(code(late.body)).toBe("CONFLICT");
    });
  });

  describe("device and tenant boundaries", () => {
    it("fails closed on an untrusted device for stocktake reads and writes", async () => {
      const registered = await client()
        .http()
        .post(`/v1/businesses/${world.a}/devices`)
        .set(bearer(as("OWNER").token))
        .set("idempotency-key", randomUUID())
        .send({ platform: "ANDROID", label: "Counter" })
        .expect(201);
      const device = RegisterDeviceResponseSchema.parse(registered.body);
      if (!device.credentialAvailable) throw new Error("expected the credential");
      const untrusted = {
        [DEVICE_ID_HEADER]: device.device.id,
        [DEVICE_CREDENTIAL_HEADER]: `tali_dev_${"Z".repeat(43)}`,
      };
      const read = await client().get("inventory/stocktakes").set(untrusted).expect(403);
      expect(code(read.body)).toBe("DEVICE_NOT_TRUSTED");
      const write = await client()
        .http()
        .post(`/v1/businesses/${world.a}/inventory/stocktakes`)
        .set(bearer(as("OWNER").token))
        .set("idempotency-key", randomUUID())
        .set(untrusted)
        .send({})
        .expect(403);
      expect(code(write.body)).toBe("DEVICE_NOT_TRUSTED");
      expect((await readInventorySnapshot()).stocktakes).toEqual([]);
      await client()
        .get("inventory/stocktakes")
        .set({ [DEVICE_ID_HEADER]: device.device.id, [DEVICE_CREDENTIAL_HEADER]: device.credential })
        .expect(200);
    });

    it("never lets business B read or change business A's stocktakes", async () => {
      const milk = await client().product();
      const id = (await create()).stocktakeId;
      const counted = await count(id, milk, { count: pieces("2") });
      const before = await readInventorySnapshot();
      const other = world.ownerB;
      const attempts = (businessId: string) => [
        () => client().get("inventory/stocktakes", other, businessId),
        () => client().get(stocktakePath(id), other, businessId),
        () => client().get(stocktakePath(id, "/lines"), other, businessId),
        () =>
          client().put(
            stocktakePath(id, `/lines/${milk.variantId}`),
            { count: pieces("9"), expectedVersion: 1 },
            other,
            businessId,
          ),
        () =>
          client().post(
            stocktakePath(id, `/lines/${milk.variantId}/remove`),
            { expectedVersion: 1 },
            other,
            businessId,
          ),
        () =>
          client().post(stocktakePath(id, "/post"), { expectedVersion: counted.stocktake.version }, other, businessId),
        () =>
          client().post(
            stocktakePath(id, "/cancel"),
            { expectedVersion: counted.stocktake.version },
            other,
            businessId,
          ),
      ];
      for (const attempt of attempts(world.a)) {
        const response = await attempt();
        expect(response.status).toBe(404);
        expect(code(response.body)).toBe("NOT_FOUND");
      }
      for (const attempt of attempts(world.b).slice(1)) {
        const response = await attempt();
        expect(response.status).toBe(404);
        expect(code(response.body)).toBe("NOT_FOUND");
      }
      const own = StocktakesResponseSchema.parse(
        (await client().get("inventory/stocktakes", other, world.b).expect(200)).body,
      );
      expect(own.items).toEqual([]);
      expect(await readInventorySnapshot()).toEqual(before);
    });
  });
});
