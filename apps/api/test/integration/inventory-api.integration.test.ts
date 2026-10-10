import { randomUUID } from "node:crypto";
import { type LocationBoundContext, parseCorrelationId } from "@tali/application";
import { readInventoryConsistency, readInventorySnapshot, tenancyFixtures } from "@tali/database/testing";
import { parseLocationId } from "@tali/domain";
import { uuidV7IdGenerator } from "@tali/integrations/platform";
import {
  AdjustmentResponseSchema,
  AdjustmentReversalResponseSchema,
  DEVICE_CREDENTIAL_HEADER,
  DEVICE_ID_HEADER,
  GoodsReceiptResponseSchema,
  GoodsReceiptReversalResponseSchema,
  type InventoryItemResponse,
  InventoryItemResponseSchema,
  InventoryItemsResponseSchema,
  InventoryMovementsResponseSchema,
  LowStockThresholdResponseSchema,
  OpeningBatchResponseSchema,
  RegisterDeviceResponseSchema,
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
  ROLES,
  type StockItem,
} from "../support/inventory-client.js";
import { bearer, type RegisteredActor } from "../support/tenancy-client.js";

describe("Build 2 Slice 5 inventory API over HTTP", () => {
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

  /** Every successful body is checked for forbidden keys and JSON-number quantities after each test. */
  function record<T>(body: T): T {
    seen.push(body);
    return body;
  }

  const as = (role: (typeof ROLES)[number]) => world.actors[role];
  const pieces = (quantityMinor: string) => ({ quantityMinor, unit: "PIECE" });

  async function balances(query = "", actor: RegisteredActor = as("OWNER")): Promise<InventoryItemResponse[]> {
    const response = await client().get(`inventory/balances${query}`, actor).expect(200);
    return record(InventoryItemsResponseSchema.parse(response.body)).items;
  }

  async function item(stock: StockItem): Promise<InventoryItemResponse> {
    const response = await client().get(`inventory/items/${stock.variantId}`).expect(200);
    return record(InventoryItemResponseSchema.parse(response.body));
  }

  /** A context bound to another, non-default location of business A. */
  async function backStoreContext(): Promise<LocationBoundContext> {
    const id = uuidV7IdGenerator.newId("location");
    await tenancyFixtures.insertLocation({ id, businessId: world.a, name: "Back store" });
    const { services } = api.runtime;
    const identity = await api.identity.verifyAccessToken(as("OWNER").token);
    const user = await services.userContexts.resolve(identity, {
      correlationId: parseCorrelationId("w5-back-store"),
      sourceChannel: "web",
    });
    const bound = await services.defaultLocations.resolveDefaultLocation(
      await services.businessContexts.resolveForUser(user, world.a),
    );
    return { ...bound, locationId: parseLocationId(id) };
  }

  describe("inventory reads", () => {
    it("lets every role read balances, an item and its movements", async () => {
      const milk = await client().product();
      await client().receive([[milk, "12"]]);
      for (const role of ROLES) {
        expect((await balances("", as(role))).map((row) => row.variantId)).toEqual([milk.variantId]);
        record(
          InventoryItemResponseSchema.parse(
            (await client().get(`inventory/items/${milk.variantId}`, as(role)).expect(200)).body,
          ),
        );
        record(
          InventoryMovementsResponseSchema.parse(
            (await client().get(`inventory/items/${milk.variantId}/movements`, as(role)).expect(200)).body,
          ),
        );
      }
    });

    it("lists tracked items with string quantities, excluding untracked products", async () => {
      const milk = await client().product({ sku: "MILK-1" });
      const sugar = await client().product({ name: "Sugar 1kg" });
      await client().product({ name: "Delivery fee", trackInventory: false });
      await client().receive([[milk, "12"]]);
      const rows = await balances();
      expect(rows.map((row) => row.variantId).sort()).toEqual([milk.variantId, sugar.variantId].sort());
      expect(rows.find((row) => row.variantId === milk.variantId)).toMatchObject({
        productId: milk.productId,
        sku: "MILK-1",
        productStatus: "ACTIVE",
        stockUnit: "PIECE",
        onHand: pieces("12"),
        balanceVersion: 1,
        threshold: null,
        thresholdVersion: 0,
        lowStock: false,
      });
      expect(rows.find((row) => row.variantId === sugar.variantId)).toMatchObject({
        onHand: pieces("0"),
        balanceVersion: 0,
      });
    });

    it("filters lowStock=true exactly, and maps an absent lowStock to every item", async () => {
      const low = await client().product();
      const plenty = await client().product();
      await client().receive([
        [low, "3"],
        [plenty, "50"],
      ]);
      for (const stock of [low, plenty]) {
        await client()
          .put(`inventory/items/${stock.variantId}/threshold`, { expectedVersion: 0, threshold: pieces("10") })
          .expect(200);
      }
      expect((await balances("?lowStock=true")).map((row) => row.variantId)).toEqual([low.variantId]);
      expect(await balances("?lowStock=false")).toHaveLength(2);
      expect(await balances()).toHaveLength(2);
      for (const bad of ["1", "yes", "TRUE", ""]) {
        const response = await client().get(`inventory/balances?lowStock=${bad}`).expect(400);
        expect(code(response.body)).toBe("VALIDATION_FAILED");
      }
    });

    it("searches by name or exact SKU and pages with a cursor", async () => {
      const milk = await client().product({ name: "Peak Milk 400g", sku: "PK-400" });
      await client().product({ name: "Sugar 1kg" });
      await client().product({ name: "Salt 500g" });
      expect((await balances("?q=milk")).map((row) => row.variantId)).toEqual([milk.variantId]);
      expect((await balances("?q=PK-400")).map((row) => row.variantId)).toEqual([milk.variantId]);
      const first = record(
        InventoryItemsResponseSchema.parse((await client().get("inventory/balances?limit=2").expect(200)).body),
      );
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = record(
        InventoryItemsResponseSchema.parse(
          (
            await client()
              .get(`inventory/balances?limit=2&after=${String(first.nextCursor)}`)
              .expect(200)
          ).body,
        ),
      );
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(code((await client().get("inventory/balances?unknown=1").expect(400)).body)).toBe("VALIDATION_FAILED");
    });

    it("finds an item by its exact normalized barcode, and not by a different one", async () => {
      const milk = await client().product({ name: "Peak Milk 400g", barcode: "4006381333931" });
      await client().product({ name: "Sugar 1kg", barcode: "5901234123457" });
      await client().product({ name: "Salt 500g" });
      for (const q of ["4006381333931", "04006381333931"]) {
        const rows = await balances(`?q=${q}`);
        expect({ q, ids: rows.map((row) => row.variantId) }).toEqual({ q, ids: [milk.variantId] });
        expect(rows[0]).toMatchObject({ barcode: "4006381333931", productStatus: "ACTIVE" });
      }
      for (const q of ["4006381333948", "400638133393", "96385074"]) {
        expect({ q, rows: await balances(`?q=${q}`) }).toEqual({ q, rows: [] });
      }
    });

    it("answers 404 for a malformed, unknown, untracked or other-tenant variant", async () => {
      const foreign = await client().product({}, world.ownerB, world.b);
      const untracked = await client().product({ trackInventory: false });
      for (const id of ["not-a-uuid", MISSING_ID, foreign.variantId, untracked.variantId]) {
        expect(code((await client().get(`inventory/items/${id}`).expect(404)).body)).toBe("NOT_FOUND");
        expect(code((await client().get(`inventory/items/${id}/movements`).expect(404)).body)).toBe("NOT_FOUND");
      }
    });

    it("reads only the default location: stock elsewhere in the business is not shown", async () => {
      const milk = await client().product();
      await client().receive([[milk, "5"]]);
      const back = await backStoreContext();
      await api.runtime.services.postGoodsReceipt.execute(back, {
        lines: [{ variantId: milk.variantId, quantityMinor: "40", unit: "PIECE" }],
        idempotencyKey: randomUUID(),
      });
      expect(await item(milk)).toMatchObject({ onHand: pieces("5"), balanceVersion: 1 });
      const movements = InventoryMovementsResponseSchema.parse(
        (await client().get(`inventory/items/${milk.variantId}/movements`).expect(200)).body,
      );
      expect(movements.items.map((movement) => movement.delta)).toEqual([pieces("5")]);
    });
  });

  describe("movement history", () => {
    it("pages newest first by movement cursor with only public fields", async () => {
      const milk = await client().product();
      for (const quantity of ["1", "2", "3"]) await client().receive([[milk, quantity]]);
      const path = `inventory/items/${milk.variantId}/movements`;
      const first = record(
        InventoryMovementsResponseSchema.parse((await client().get(`${path}?limit=2`).expect(200)).body),
      );
      expect(first.items.map((movement) => movement.delta.quantityMinor)).toEqual(["3", "2"]);
      expect(first.items.map((movement) => movement.balanceAfter.quantityMinor)).toEqual(["6", "3"]);
      const second = record(
        InventoryMovementsResponseSchema.parse(
          (
            await client()
              .get(`${path}?limit=2&after=${String(first.nextCursor)}`)
              .expect(200)
          ).body,
        ),
      );
      expect(second.items.map((movement) => movement.delta.quantityMinor)).toEqual(["1"]);
      expect(second.nextCursor).toBeNull();
      expect(Object.keys(first.items[0] ?? {}).sort()).toEqual(
        [
          "movementId",
          "type",
          "delta",
          "balanceAfter",
          "balanceVersion",
          "source",
          "pack",
          "reversesMovementId",
          "reasonCode",
          "reasonNote",
          "sourceChannel",
          "occurredAt",
          "businessDate",
        ].sort(),
      );
      expect(code((await client().get(`${path}?after=not-a-cursor`).expect(400)).body)).toBe("VALIDATION_FAILED");
    });

    it("rejects any cursor that is not a movement of this exact item, without saying why", async () => {
      const milk = await client().product();
      const sugar = await client().product();
      await client().receive([[milk, "2"]]);
      const sugarMovement = GoodsReceiptResponseSchema.parse((await client().receive([[sugar, "1"]])).body)
        .movements[0];
      const back = await backStoreContext();
      const elsewhere = await api.runtime.services.postGoodsReceipt.execute(back, {
        lines: [{ variantId: milk.variantId, quantityMinor: "7", unit: "PIECE" }],
        idempotencyKey: randomUUID(),
      });
      const foreignItem = await client().product({}, world.ownerB, world.b);
      const foreignMovement = GoodsReceiptResponseSchema.parse(
        (
          await client()
            .keyed(
              "inventory/goods-receipts",
              { lines: [{ variantId: foreignItem.variantId, ...pieces("1") }] },
              world.ownerB,
              randomUUID(),
              world.b,
            )
            .expect(201)
        ).body,
      ).movements[0];
      const cursors = {
        malformed: "not-a-cursor",
        unknownUuid: MISSING_ID,
        otherVariant: sugarMovement?.movementId,
        otherLocation: elsewhere.movements[0]?.id,
        otherBusiness: foreignMovement?.movementId,
      };
      const bodies = new Set<string>();
      for (const [label, cursor] of Object.entries(cursors)) {
        if (cursor === undefined) throw new Error(`no ${label} cursor`);
        const response = await client().get(`inventory/items/${milk.variantId}/movements?after=${cursor}`);
        expect({ label, status: response.status, code: code(response.body) }).toEqual({
          label,
          status: 400,
          code: "VALIDATION_FAILED",
        });
        const text = JSON.stringify(response.body);
        expect(text).not.toContain(cursor);
        expect(text).not.toMatch(/location|business|variant|tenant|another|belong/i);
        if (label !== "malformed") bodies.add(text);
      }
      expect(bodies.size).toBe(1);
    });

    it("ends with an empty page after the oldest movement and keeps newest-first versions across pages", async () => {
      const milk = await client().product();
      for (const quantity of ["1", "2", "3", "4", "5"]) await client().receive([[milk, quantity]]);
      const path = `inventory/items/${milk.variantId}/movements`;
      const versions: number[] = [];
      let after: string | null = null;
      let oldest: string | undefined;
      do {
        const query: string = after === null ? "?limit=2" : `?limit=2&after=${after}`;
        const page = record(
          InventoryMovementsResponseSchema.parse((await client().get(`${path}${query}`).expect(200)).body),
        );
        versions.push(...page.items.map((movement) => movement.balanceVersion));
        oldest = page.items.at(-1)?.movementId ?? oldest;
        after = page.nextCursor;
      } while (after !== null);
      expect(versions).toEqual([5, 4, 3, 2, 1]);
      if (oldest === undefined) throw new Error("no movements");
      const end = InventoryMovementsResponseSchema.parse(
        (await client().get(`${path}?after=${oldest}`).expect(200)).body,
      );
      expect(end).toEqual({ items: [], nextCursor: null });
    });
  });

  describe("stock documents", () => {
    it("records opening stock (201) and reads the same batch back", async () => {
      const milk = await client().product();
      const created = await client()
        .keyed("inventory/opening-stock", { lines: [{ variantId: milk.variantId, ...pieces("20") }], note: "Day one" })
        .expect(201);
      expect(created.headers["idempotent-replayed"]).toBeUndefined();
      const batch = record(OpeningBatchResponseSchema.parse(created.body));
      expect(batch.document).toMatchObject({ note: "Day one" });
      expect(batch.movements).toEqual([
        expect.objectContaining({
          variantId: milk.variantId,
          type: "OPENING",
          delta: pieces("20"),
          source: { kind: "OPENING_BATCH", id: batch.document.id },
        }),
      ]);
      const read = await client().get(`inventory/opening-batches/${batch.document.id}`).expect(200);
      expect(record(OpeningBatchResponseSchema.parse(read.body))).toEqual(batch);
    });

    it("posts a goods receipt with pack lines, reads it, and reverses it state-settingly", async () => {
      const milk = await client().product();
      const crate = await client().pack(milk, "24");
      const created = await client()
        .keyed("inventory/goods-receipts", {
          lines: [{ variantId: milk.variantId, packId: crate, packCount: "2" }],
          reference: "DN-1001",
        })
        .expect(201);
      const receipt = record(GoodsReceiptResponseSchema.parse(created.body));
      expect(receipt.document).toMatchObject({ reference: "DN-1001", status: "POSTED", reversedAt: null });
      expect(receipt.movements[0]).toMatchObject({
        type: "PURCHASE_RECEIPT",
        delta: pieces("48"),
        pack: { packId: crate, count: "2", factorMinor: "24" },
      });
      const path = `inventory/goods-receipts/${receipt.document.id}`;
      expect(record(GoodsReceiptResponseSchema.parse((await client().get(path).expect(200)).body))).toEqual(receipt);

      const reversed = record(
        GoodsReceiptReversalResponseSchema.parse(
          (await client().post(`${path}/reverse`, { reason: "Wrong delivery" }).expect(200)).body,
        ),
      );
      expect(reversed).toMatchObject({
        changed: true,
        document: { status: "REVERSED", reversalReason: "Wrong delivery" },
      });
      expect(reversed.reversalMovements).toEqual([
        expect.objectContaining({ delta: pieces("-48"), reversesMovementId: receipt.movements[0]?.movementId }),
      ]);
      const again = GoodsReceiptReversalResponseSchema.parse(
        (await client().post(`${path}/reverse`, { reason: "Wrong delivery" }).expect(200)).body,
      );
      expect(again).toMatchObject({ changed: false, reversalMovements: [] });
      expect(await item(milk)).toMatchObject({ onHand: pieces("0") });
      const read = GoodsReceiptResponseSchema.parse((await client().get(path).expect(200)).body);
      expect(read.document).toMatchObject({ status: "REVERSED", reversalReason: "Wrong delivery" });
    });

    it("records adjustments and write-offs, reads them by kind, and reverses them", async () => {
      const milk = await client().product();
      await client().receive([[milk, "10"]]);
      const adjusted = record(
        AdjustmentResponseSchema.parse(
          (
            await client()
              .keyed("inventory/adjustments", {
                lines: [{ variantId: milk.variantId, ...pieces("2"), direction: "DECREASE" }],
                reasonCode: "DATA_ENTRY_CORRECTION",
              })
              .expect(201)
          ).body,
        ),
      );
      expect(adjusted.document).toMatchObject({ kind: "ADJUSTMENT", reasonCode: "DATA_ENTRY_CORRECTION" });
      const writtenOff = record(
        AdjustmentResponseSchema.parse(
          (
            await client()
              .keyed("inventory/write-offs", {
                lines: [{ variantId: milk.variantId, ...pieces("3") }],
                reasonCode: "OTHER",
                reasonNote: "Rats",
              })
              .expect(201)
          ).body,
        ),
      );
      expect(writtenOff.document).toMatchObject({ kind: "WRITE_OFF", reasonCode: "OTHER", reasonNote: "Rats" });
      expect(writtenOff.movements[0]).toMatchObject({ type: "WRITE_OFF", delta: pieces("-3") });
      for (const document of [adjusted, writtenOff]) {
        const read = await client().get(`inventory/adjustments/${document.document.id}`).expect(200);
        expect(record(AdjustmentResponseSchema.parse(read.body))).toEqual(document);
      }
      const reversed = record(
        AdjustmentReversalResponseSchema.parse(
          (
            await client()
              .post(`inventory/adjustments/${writtenOff.document.id}/reverse`, { reason: "Found them" })
              .expect(200)
          ).body,
        ),
      );
      expect(reversed).toMatchObject({ changed: true, document: { kind: "WRITE_OFF", status: "REVERSED" } });
      expect(await item(milk)).toMatchObject({ onHand: pieces("8") });
    });

    it("answers 404 for malformed, unknown, other-kind and other-tenant documents", async () => {
      const milk = await client().product();
      const receipt = GoodsReceiptResponseSchema.parse((await client().receive([[milk, "1"]])).body);
      const foreignItem = await client().product({}, world.ownerB, world.b);
      const foreign = GoodsReceiptResponseSchema.parse(
        (
          await client()
            .keyed(
              "inventory/goods-receipts",
              { lines: [{ variantId: foreignItem.variantId, ...pieces("1") }] },
              world.ownerB,
              randomUUID(),
              world.b,
            )
            .expect(201)
        ).body,
      );
      for (const id of ["not-a-uuid", MISSING_ID, foreign.document.id]) {
        for (const path of ["opening-batches", "goods-receipts", "adjustments"]) {
          expect(code((await client().get(`inventory/${path}/${id}`).expect(404)).body)).toBe("NOT_FOUND");
        }
        for (const path of ["goods-receipts", "adjustments"]) {
          const response = await client().post(`inventory/${path}/${id}/reverse`, { reason: "x" }).expect(404);
          expect(code(response.body)).toBe("NOT_FOUND");
        }
      }
      expect(code((await client().get(`inventory/adjustments/${receipt.document.id}`).expect(404)).body)).toBe(
        "NOT_FOUND",
      );
      expect(code((await client().get(`inventory/opening-batches/${receipt.document.id}`).expect(404)).body)).toBe(
        "NOT_FOUND",
      );
    });

    it("enforces the document permission matrix server-side", async () => {
      const milk = await client().product();
      const line = { variantId: milk.variantId, ...pieces("1") };
      const denied: [string, (typeof ROLES)[number][], unknown][] = [
        ["inventory/opening-stock", ["CASHIER", "STOCK_KEEPER", "ACCOUNTANT"], { lines: [line] }],
        ["inventory/goods-receipts", ["CASHIER", "ACCOUNTANT"], { lines: [line] }],
        [
          "inventory/adjustments",
          ["CASHIER", "STOCK_KEEPER", "ACCOUNTANT"],
          { lines: [{ ...line, direction: "INCREASE" }], reasonCode: "FOUND_STOCK" },
        ],
        ["inventory/write-offs", ["CASHIER", "STOCK_KEEPER", "ACCOUNTANT"], { lines: [line], reasonCode: "DAMAGED" }],
      ];
      for (const [path, roles, body] of denied) {
        for (const role of roles) {
          const response = await client().keyed(path, body, as(role));
          expect({ path, role, status: response.status }).toEqual({ path, role, status: 403 });
          expect(code(response.body)).toBe("PERMISSION_DENIED");
        }
      }
      const receipt = GoodsReceiptResponseSchema.parse(
        (await client().receive([[milk, "5"]], as("STOCK_KEEPER"))).body,
      );
      const reverse = await client()
        .post(`inventory/goods-receipts/${receipt.document.id}/reverse`, { reason: "x" }, as("STOCK_KEEPER"))
        .expect(403);
      expect(code(reverse.body)).toBe("PERMISSION_DENIED");
      expect((await readInventorySnapshot()).movements).toHaveLength(1);
    });

    it("rejects JSON-number quantities, client locations and unknown fields", async () => {
      const milk = await client().product();
      const before = await readInventorySnapshot();
      for (const body of [
        { lines: [{ variantId: milk.variantId, quantityMinor: 5, unit: "PIECE" }] },
        { lines: [{ variantId: milk.variantId, ...pieces("5") }], locationId: MISSING_ID },
        { lines: [{ variantId: milk.variantId, ...pieces("5"), locationId: MISSING_ID }] },
        { lines: [{ variantId: milk.variantId, ...pieces("0") }] },
        { lines: [] },
        { lines: [{ variantId: milk.variantId, ...pieces("5") }], reference: "R".repeat(65) },
      ]) {
        const response = await client().keyed("inventory/goods-receipts", body).expect(400);
        expect(code(response.body)).toBe("VALIDATION_FAILED");
      }
      expect(await readInventorySnapshot()).toEqual(before);
    });
  });

  describe("keyed idempotency", () => {
    it("requires a key, replays with 201 and Idempotent-Replayed, and rejects a reused key", async () => {
      const milk = await client().product();
      const lines = [{ variantId: milk.variantId, ...pieces("4") }];
      const creates: [string, Record<string, unknown>, Record<string, unknown>][] = [
        ["inventory/opening-stock", { lines }, { lines, note: "other" }],
        ["inventory/goods-receipts", { lines }, { lines, reference: "other" }],
        [
          "inventory/adjustments",
          { lines: [{ ...lines[0], direction: "INCREASE" }], reasonCode: "FOUND_STOCK" },
          { lines: [{ ...lines[0], direction: "INCREASE" }], reasonCode: "OTHER", reasonNote: "other" },
        ],
        ["inventory/write-offs", { lines, reasonCode: "DAMAGED" }, { lines, reasonCode: "EXPIRED" }],
      ];
      for (const [path, body, different] of creates) {
        const missing = await client().keyed(path, body, as("OWNER"), null).expect(400);
        expect(code(missing.body)).toBe("IDEMPOTENCY_KEY_REQUIRED");
        const key = randomUUID();
        const fresh = await client().keyed(path, body, as("OWNER"), key).expect(201);
        expect(fresh.headers["idempotent-replayed"]).toBeUndefined();
        const movements = (await readInventorySnapshot()).movements.length;
        const replay = await client().keyed(path, body, as("OWNER"), key).expect(201);
        expect(replay.headers["idempotent-replayed"]).toBe("true");
        expect(replay.body).toEqual(fresh.body);
        const reused = await client().keyed(path, different, as("OWNER"), key).expect(409);
        expect(code(reused.body)).toBe("IDEMPOTENCY_KEY_REUSED");
        expect((await readInventorySnapshot()).movements).toHaveLength(movements);
      }
    });
  });

  describe("low-stock thresholds", () => {
    it("lets OWNER, MANAGER and STOCK_KEEPER set and clear, and denies CASHIER and ACCOUNTANT", async () => {
      const milk = await client().product();
      const path = `inventory/items/${milk.variantId}/threshold`;
      let version = 0;
      for (const role of ["OWNER", "MANAGER", "STOCK_KEEPER"] as const) {
        const set = record(
          LowStockThresholdResponseSchema.parse(
            (
              await client()
                .put(path, { expectedVersion: version, threshold: pieces("5") }, as(role))
                .expect(200)
            ).body,
          ),
        );
        version = set.version;
        expect(set).toMatchObject({ variantId: milk.variantId, threshold: pieces("5") });
      }
      for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
        const denied = await client().put(path, { expectedVersion: version, threshold: pieces("6") }, as(role));
        expect(denied.status).toBe(403);
        expect(
          code((await client().post(`${path}/clear`, { expectedVersion: version }, as(role)).expect(403)).body),
        ).toBe("PERMISSION_DENIED");
      }
      const cleared = record(
        LowStockThresholdResponseSchema.parse(
          (await client().post(`${path}/clear`, { expectedVersion: version }).expect(200)).body,
        ),
      );
      expect(cleared).toMatchObject({ threshold: null, changed: true });
      const again = LowStockThresholdResponseSchema.parse(
        (await client().post(`${path}/clear`, { expectedVersion: cleared.version }).expect(200)).body,
      );
      expect(again).toMatchObject({ threshold: null, changed: false, version: cleared.version });
      expect(await item(milk)).toMatchObject({ threshold: null, thresholdVersion: cleared.version });
    });

    it("validates the body and rejects a stale version with 409", async () => {
      const milk = await client().product();
      const path = `inventory/items/${milk.variantId}/threshold`;
      for (const body of [
        { expectedVersion: -1, threshold: pieces("5") },
        { expectedVersion: 1.5, threshold: pieces("5") },
        { expectedVersion: "0", threshold: pieces("5") },
        { threshold: pieces("5") },
        { expectedVersion: 0, threshold: { quantityMinor: 5, unit: "PIECE" } },
        { expectedVersion: 0, threshold: pieces("5"), locationId: MISSING_ID },
      ]) {
        expect(code((await client().put(path, body).expect(400)).body)).toBe("VALIDATION_FAILED");
      }
      await client()
        .put(path, { expectedVersion: 0, threshold: pieces("5") })
        .expect(200);
      expect(
        code(
          (
            await client()
              .put(path, { expectedVersion: 0, threshold: pieces("7") })
              .expect(409)
          ).body,
        ),
      ).toBe("VERSION_CONFLICT");
      expect(code((await client().post(`${path}/clear`, { expectedVersion: 5 }).expect(409)).body)).toBe(
        "VERSION_CONFLICT",
      );
      expect(code((await client().post(`${path}/clear`, { expectedVersion: -1 }).expect(400)).body)).toBe(
        "VALIDATION_FAILED",
      );
    });

    it("rejects excess precision and wrong quantity shapes without changing stock or thresholds", async () => {
      const milk = await client().product();
      const rice = await client().product({ name: "Rice", stockUnit: "KG" });
      const crate = await client().pack(milk, "24");
      await client().receive([[milk, "8"]]);
      const before = await readInventorySnapshot();
      const cases: [string, StockItem, unknown][] = [
        ["KG scale 3, four decimals", rice, { decimal: "1.2345", unit: "KG" }],
        ["PIECE scale 0, one decimal", milk, { decimal: "1.5", unit: "PIECE" }],
        ["both quantityMinor and decimal", milk, { quantityMinor: "1", decimal: "1", unit: "PIECE" }],
        ["neither quantityMinor nor decimal", milk, { unit: "PIECE" }],
        ["pack fields", milk, { packId: crate, packCount: "1" }],
        ["pack fields with a unit", milk, { packId: crate, packCount: "1", unit: "PIECE" }],
        ["unknown extra field", milk, { quantityMinor: "1", unit: "PIECE", note: "x" }],
      ];
      for (const [label, stock, threshold] of cases) {
        const response = await client().put(`inventory/items/${stock.variantId}/threshold`, {
          expectedVersion: 0,
          threshold,
        });
        expect({ label, status: response.status, code: code(response.body) }).toEqual({
          label,
          status: 400,
          code: "VALIDATION_FAILED",
        });
      }
      expect(await readInventorySnapshot()).toEqual(before);
      expect(await item(milk)).toMatchObject({ onHand: pieces("8"), threshold: null, thresholdVersion: 0 });
    });

    it("answers 401 to unauthenticated threshold writes without changing the threshold", async () => {
      const milk = await client().product();
      const path = client().url(`inventory/items/${milk.variantId}/threshold`);
      for (const call of [
        () =>
          client()
            .http()
            .put(path)
            .send({ expectedVersion: 0, threshold: pieces("5") }),
        () => client().http().post(`${path}/clear`).send({ expectedVersion: 0 }),
      ]) {
        expect(code((await call().expect(401)).body)).toBe("UNAUTHENTICATED");
      }
      expect(await item(milk)).toMatchObject({ threshold: null, thresholdVersion: 0 });
    });

    it("keeps an archived item with residual stock listed but never low stock", async () => {
      const clearance = await client().product();
      await client().receive([[clearance, "1"]]);
      await client()
        .put(`inventory/items/${clearance.variantId}/threshold`, { expectedVersion: 0, threshold: pieces("5") })
        .expect(200);
      expect(await item(clearance)).toMatchObject({ lowStock: true });
      await client().archive(clearance);
      expect(await item(clearance)).toMatchObject({
        productStatus: "ARCHIVED",
        onHand: pieces("1"),
        threshold: pieces("5"),
        lowStock: false,
      });
      expect((await balances()).map((row) => row.variantId)).toEqual([clearance.variantId]);
      expect(await balances("?lowStock=true")).toEqual([]);
    });
  });

  describe("device and tenant boundaries", () => {
    it("fails closed on untrusted device headers and accepts a trusted device", async () => {
      const milk = await client().product();
      const registered = await client()
        .http()
        .post(`/v1/businesses/${world.a}/devices`)
        .set(bearer(as("OWNER").token))
        .set("idempotency-key", randomUUID())
        .send({ platform: "ANDROID", label: "Store counter" })
        .expect(201);
      const device = RegisterDeviceResponseSchema.parse(registered.body);
      if (!device.credentialAvailable) throw new Error("expected the credential");
      const trusted = { [DEVICE_ID_HEADER]: device.device.id, [DEVICE_CREDENTIAL_HEADER]: device.credential };
      await client().get("inventory/balances").set(trusted).expect(200);
      const before = await readInventorySnapshot();
      for (const headers of [
        { [DEVICE_ID_HEADER]: device.device.id, [DEVICE_CREDENTIAL_HEADER]: `tali_dev_${"Z".repeat(43)}` },
        { [DEVICE_ID_HEADER]: device.device.id },
        { [DEVICE_ID_HEADER]: "not-a-uuid", [DEVICE_CREDENTIAL_HEADER]: device.credential },
      ]) {
        const read = await client().get("inventory/balances").set(headers).expect(403);
        expect(code(read.body)).toBe("DEVICE_NOT_TRUSTED");
        const write = await client()
          .http()
          .post(`/v1/businesses/${world.a}/inventory/goods-receipts`)
          .set(bearer(as("OWNER").token))
          .set("idempotency-key", randomUUID())
          .set(headers)
          .send({ lines: [{ variantId: milk.variantId, ...pieces("1") }] })
          .expect(403);
        expect(code(write.body)).toBe("DEVICE_NOT_TRUSTED");
      }
      expect(await readInventorySnapshot()).toEqual(before);
    });

    it("never lets business B read or change business A's stock", async () => {
      const milk = await client().product();
      const receipt = GoodsReceiptResponseSchema.parse((await client().receive([[milk, "9"]])).body);
      const before = await readInventorySnapshot();
      const other = world.ownerB;
      const a = world.a;
      const b = world.b;
      const attempts = [
        () => client().get("inventory/balances", other, a),
        () => client().get(`inventory/items/${milk.variantId}`, other, a),
        () => client().get(`inventory/items/${milk.variantId}`, other, b),
        () => client().get(`inventory/items/${milk.variantId}/movements`, other, b),
        () => client().get(`inventory/goods-receipts/${receipt.document.id}`, other, b),
        () => client().post(`inventory/goods-receipts/${receipt.document.id}/reverse`, { reason: "x" }, other, b),
        () =>
          client().put(
            `inventory/items/${milk.variantId}/threshold`,
            { expectedVersion: 0, threshold: pieces("1") },
            other,
            b,
          ),
        () => client().post(`inventory/items/${milk.variantId}/threshold/clear`, { expectedVersion: 0 }, other, b),
        () =>
          client().keyed(
            "inventory/goods-receipts",
            { lines: [{ variantId: milk.variantId, ...pieces("1") }] },
            other,
            randomUUID(),
            b,
          ),
        () =>
          client().keyed(
            "inventory/write-offs",
            { lines: [{ variantId: milk.variantId, ...pieces("1") }], reasonCode: "DAMAGED" },
            other,
            randomUUID(),
            b,
          ),
      ];
      for (const attempt of attempts) {
        const response = await attempt();
        expect(response.status).toBe(404);
        expect(code(response.body)).toBe("NOT_FOUND");
        expect(JSON.stringify(response.body)).not.toContain(milk.variantId);
      }
      expect(
        InventoryItemsResponseSchema.parse((await client().get("inventory/balances", other, b).expect(200)).body).items,
      ).toEqual([]);
      expect(await readInventorySnapshot()).toEqual(before);
    });
  });
});
