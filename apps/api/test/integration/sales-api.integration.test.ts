import { randomUUID } from "node:crypto";
import { type LocationBoundContext, parseCorrelationId } from "@tali/application";
import {
  readInventoryConsistency,
  readInventorySnapshot,
  readLedgerConsistency,
  readSalesConsistency,
  readTenancySnapshot,
  tenancyFixtures,
} from "@tali/database/testing";
import { parseLocationId } from "@tali/domain";
import { uuidV7IdGenerator } from "@tali/integrations/platform";
import {
  DiscountExceedsLineErrorEnvelopeSchema,
  InsufficientStockErrorEnvelopeSchema,
  InventoryItemResponseSchema,
  InventoryMovementsResponseSchema,
  PriceChangedErrorEnvelopeSchema,
  PriceNotSetErrorEnvelopeSchema,
  ProductArchivedErrorEnvelopeSchema,
  ProductResponseSchema,
  type SaleResponse,
  SaleResponseSchema,
  SalesResponseSchema,
  TenderTotalMismatchErrorEnvelopeSchema,
} from "@tali/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ApiHarness, startApi } from "../support/api-harness.js";
import { registerDevice, untrustedDeviceCases } from "../support/device-trust.js";
import {
  code,
  type InventoryWorld,
  inventoryWorld,
  keysDeep,
  MISSING_ID,
  type Role,
} from "../support/inventory-client.js";
import { FORBIDDEN_SALES_KEYS, nonStringAmounts, type SellableItem, salesClient } from "../support/sales-client.js";
import { SALES_ROUTES } from "../support/sales-routes.js";
import { bearer, createBusinessAs, registerActor } from "../support/tenancy-client.js";

const COST_KEYS = ["costStatus", "cogsTotal", "cost"];
const TENDER_REFERENCE = "TRX-7781-CONFIDENTIAL";

describe("Build 3 Slice 6 sales API over HTTP", () => {
  let api: ApiHarness;
  let world: InventoryWorld;
  const seen: unknown[] = [];
  const client = () => salesClient(api, () => world);
  const as = (role: Role) => world.actors[role];

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
      expect(FORBIDDEN_SALES_KEYS.filter((key) => keys.has(key))).toEqual([]);
      expect(nonStringAmounts(body)).toEqual([]);
    }
    expect(await readSalesConsistency()).toEqual([]);
    expect(await readLedgerConsistency()).toEqual([]);
    expect(await readInventoryConsistency()).toEqual([]);
  });

  /** Every body is checked for forbidden keys and JSON-number amounts after each test. */
  function record<T>(body: T): T {
    seen.push(body);
    return body;
  }
  const sale = (body: unknown): SaleResponse => record(SaleResponseSchema.parse(body));

  async function onHand(item: SellableItem): Promise<string> {
    const response = await client().get(`inventory/items/${item.variantId}`).expect(200);
    return InventoryItemResponseSchema.parse(response.body).onHand.quantityMinor;
  }

  async function defaultLocationOf(businessId: string): Promise<string> {
    const location = (await readTenancySnapshot()).locations.find(
      (row) => row.businessId === businessId && row.isDefault,
    );
    if (location === undefined) throw new Error("no default location");
    return location.id;
  }

  async function salesOf(businessId: string): Promise<number> {
    const owner = businessId === world.b ? world.ownerB : as("OWNER");
    const response = await client().get("sales?limit=100", owner, businessId).expect(200);
    return SalesResponseSchema.parse(response.body).items.length;
  }

  /** Every durable effect a rejected sale command must leave untouched. */
  async function effects(businessId = world.a) {
    return {
      sales: await salesOf(businessId),
      journalLines: await client().journalLineCount(businessId),
      movements: (await readInventorySnapshot()).movements.length,
      audit: (await readTenancySnapshot()).businessAudit.length,
    };
  }

  /** A context bound to another, non-default location of business A. */
  async function backStoreContext(): Promise<LocationBoundContext> {
    const id = uuidV7IdGenerator.newId("location");
    await tenancyFixtures.insertLocation({ id, businessId: world.a, name: "Back store" });
    const { services } = api.runtime;
    const identity = await api.identity.verifyAccessToken(as("OWNER").token);
    const user = await services.userContexts.resolve(identity, {
      correlationId: parseCorrelationId("s6-back-store"),
      sourceChannel: "web",
    });
    const bound = await services.defaultLocations.resolveDefaultLocation(
      await services.businessContexts.resolveForUser(user, world.a),
    );
    return { ...bound, locationId: parseLocationId(id) };
  }

  describe("recording a sale", () => {
    it("records a valued cash sale at the default location from the server price, with change, cost and a receipt", async () => {
      const milk = await client().pricedItem({ price: "50000", stock: "10", stockCost: "700000" });
      const body = client().saleBody(
        [[milk, "2"]],
        [{ method: "CASH", amount: client().money("100000"), cashReceived: client().money("120000") }],
      );
      const response = await client().sell(body).expect(201);
      expect(response.headers["idempotent-replayed"]).toBeUndefined();
      const recorded = sale(response.body);
      expect(recorded).toMatchObject({
        saleId: body.saleId,
        locationId: await defaultLocationOf(world.a),
        receiptNumber: "S-000001",
        status: "POSTED",
        currency: "KES",
        grossTotal: client().money("100000"),
        discountTotal: client().money("0"),
        taxTotal: client().money("0"),
        total: client().money("100000"),
        costStatus: "VALUED",
        cogsTotal: client().money("140000"),
        deviceReportedAt: null,
        reversedAt: null,
        reversalTenderUnwoundConfirmed: null,
      });
      const productName = recorded.lines[0]?.productName ?? "";
      expect(productName).toMatch(/^Peak Milk /);
      expect(recorded.lines).toEqual([
        {
          lineNumber: 1,
          variantId: milk.variantId,
          productName,
          sku: null,
          tracked: true,
          quantity: { quantityMinor: "2", unit: "PIECE" },
          unitScale: 0,
          unitPrice: client().money("50000"),
          priceVersion: milk.priceVersion,
          gross: client().money("100000"),
          discount: { kind: "NONE" },
          discountAmount: client().money("0"),
          net: client().money("100000"),
          taxKind: "NONE",
          tax: client().money("0"),
          total: client().money("100000"),
          costStatus: "VALUED",
          cost: client().money("140000"),
        },
      ]);
      expect(recorded.tenders).toEqual([
        {
          tenderNumber: 1,
          method: "CASH",
          amount: client().money("100000"),
          reference: null,
          verificationStatus: "NOT_APPLICABLE",
          cashReceived: client().money("120000"),
          changeGiven: client().money("20000"),
        },
      ]);
      expect(await onHand(milk)).toBe("8");
      expect(sale((await client().get(`sales/${body.saleId}`).expect(200)).body)).toEqual(recorded);

      const second = sale(
        (
          await client()
            .sell(client().saleBody([[milk, "1"]]))
            .expect(201)
        ).body,
      );
      expect(second.receiptNumber).toBe("S-000002");

      const audit = (await readTenancySnapshot()).businessAudit.filter(
        (row) => row.businessId === world.a && row.entityId === body.saleId,
      );
      expect(audit.map((row) => [row.action, row.entityType, row.idempotencyKey])).toEqual([
        ["sale.recorded", "sale", body.saleId],
      ]);
    });

    it("splits a sale over every tender method; only cash has change and only non-cash is unverified", async () => {
      const bread = await client().pricedItem({ price: "1000", tracked: false });
      const body = client().saleBody(
        [[bread, "4"]],
        [
          { method: "CASH", amount: client().money("900"), cashReceived: client().money("1000") },
          { method: "BANK_TRANSFER", amount: client().money("1100"), reference: TENDER_REFERENCE },
          { method: "POS_CARD", amount: client().money("1000") },
          { method: "OTHER", amount: client().money("1000") },
        ],
      );
      const recorded = sale((await client().sell(body).expect(201)).body);
      expect(recorded.total).toEqual(client().money("4000"));
      expect(recorded.tenders).toEqual([
        {
          tenderNumber: 1,
          method: "CASH",
          amount: client().money("900"),
          reference: null,
          verificationStatus: "NOT_APPLICABLE",
          cashReceived: client().money("1000"),
          changeGiven: client().money("100"),
        },
        {
          tenderNumber: 2,
          method: "BANK_TRANSFER",
          amount: client().money("1100"),
          reference: TENDER_REFERENCE,
          verificationStatus: "NOT_VERIFIED",
          cashReceived: null,
          changeGiven: null,
        },
        {
          tenderNumber: 3,
          method: "POS_CARD",
          amount: client().money("1000"),
          reference: null,
          verificationStatus: "NOT_VERIFIED",
          cashReceived: null,
          changeGiven: null,
        },
        {
          tenderNumber: 4,
          method: "OTHER",
          amount: client().money("1000"),
          reference: null,
          verificationStatus: "NOT_VERIFIED",
          cashReceived: null,
          changeGiven: null,
        },
      ]);
      expect(JSON.stringify(api.logs)).not.toContain(TENDER_REFERENCE);
    });

    it("keeps the device time as evidence only", async () => {
      const bread = await client().pricedItem({ price: "1000", tracked: false });
      const body = { ...client().saleBody([[bread, "1"]]), deviceReportedAt: "2020-01-01T08:00:00.000Z" };
      const recorded = sale((await client().sell(body).expect(201)).body);
      expect(recorded.deviceReportedAt).toBe("2020-01-01T08:00:00.000Z");
      expect(recorded.occurredAt.startsWith("2020-")).toBe(false);
    });

    it("sells untracked items without stock and unvalued stock without cost", async () => {
      const bag = await client().pricedItem({ price: "500", tracked: false });
      const loose = await client().pricedItem({ price: "2000", stock: "5" });
      const valued = await client().pricedItem({ price: "3000", stock: "5", stockCost: "10000" });
      const movementsBefore = (await readInventorySnapshot()).movements.length;

      const untracked = sale(
        (
          await client()
            .sell(client().saleBody([[bag, "3"]]))
            .expect(201)
        ).body,
      );
      expect(untracked).toMatchObject({ costStatus: "NOT_APPLICABLE" });
      expect(untracked.lines[0]).toMatchObject({ tracked: false, costStatus: "NOT_APPLICABLE", cost: null });
      expect((await readInventorySnapshot()).movements.length).toBe(movementsBefore);

      const unvalued = sale(
        (
          await client()
            .sell(client().saleBody([[loose, "2"]]))
            .expect(201)
        ).body,
      );
      expect(unvalued).toMatchObject({ costStatus: "UNVALUED" });
      expect(unvalued.lines[0]).toMatchObject({ tracked: true, costStatus: "UNVALUED", cost: null });
      expect(await onHand(loose)).toBe("3");

      const partial = sale(
        (
          await client()
            .sell(
              client().saleBody([
                [loose, "1"],
                [valued, "1"],
              ]),
            )
            .expect(201)
        ).body,
      );
      expect(partial).toMatchObject({ costStatus: "PARTIAL", cogsTotal: client().money("2000") });
      expect(partial.lines.map((line) => line.costStatus)).toEqual(["UNVALUED", "VALUED"]);
    });

    it("rejects a location, price, total, tax, cost or other server-owned field and writes nothing", async () => {
      const milk = await client().pricedItem({ price: "50000", stock: "5" });
      const base = client().saleBody([[milk, "1"]]);
      const before = await effects();
      const line = base.lines[0] ?? {};
      const variants: Record<string, unknown>[] = [
        { ...base, locationId: await defaultLocationOf(world.a) },
        { ...base, total: client().money("1") },
        { ...base, receiptNumber: "S-999999" },
        { ...base, status: "POSTED" },
        { ...base, currency: "KES" },
        { ...base, sourceChannel: "web" },
        { ...base, lines: [{ ...line, unitPrice: client().money("1") }] },
        { ...base, lines: [{ ...line, price: client().money("1") }] },
        { ...base, lines: [{ ...line, taxKind: "EXEMPT" }] },
        { ...base, lines: [{ ...line, tax: client().money("0") }] },
        { ...base, lines: [{ ...line, cost: client().money("0") }] },
        { ...base, lines: [{ ...line, discount: { kind: "NONE" } }] },
        { ...base, lines: [{ ...line, discount: { kind: "BASIS_POINTS", basisPoints: 10000 } }] },
        { ...base, lines: [{ ...line, quantity: { quantityMinor: 1, unit: "PIECE" } }] },
        { ...base, tenders: [{ method: "CASH", amount: { amountMinor: 50000, currency: "KES" } }] },
        { ...base, tenders: [{ method: "CASH", amount: client().money("50000"), changeGiven: client().money("0") }] },
        { ...base, tenders: [{ method: "CASH", amount: client().money("50000"), verificationStatus: "VERIFIED" }] },
      ];
      for (const variant of variants) {
        const response = await client().sell(variant as typeof base);
        expect({ variant, status: response.status, code: code(response.body) }).toEqual({
          variant,
          status: 400,
          code: "VALIDATION_FAILED",
        });
      }
      expect(await effects()).toEqual(before);
    });
  });

  describe("currency", () => {
    it("rejects money in any currency but the business currency and records in a non-NGN currency", async () => {
      const owner = as("OWNER");
      const naira = (await createBusinessAs(api, owner, { name: "Duka Lagos", currencyCode: "NGN" })).business.id;
      const rice = await client().pricedItem({ price: "2500", tracked: false, businessId: naira, currency: "NGN" });
      const ngn = (amountMinor: string) => client().money(amountMinor, "NGN");
      const base = client().saleBody([[rice, "2"]], [{ method: "CASH", amount: ngn("5000") }], "NGN");
      const line = base.lines[0] ?? {};
      const before = await effects(naira);
      const wrong: Record<string, unknown>[] = [
        { ...base, tenders: [{ method: "CASH", amount: client().money("5000", "KES") }] },
        { ...base, tenders: [{ method: "CASH", amount: client().money("5000", "USD") }] },
        { ...base, tenders: [{ method: "CASH", amount: ngn("5000"), cashReceived: client().money("6000", "KES") }] },
        {
          ...base,
          lines: [{ ...line, discount: { kind: "FIXED", amount: client().money("100", "KES") } }],
          tenders: [{ method: "CASH", amount: ngn("4900") }],
        },
      ];
      for (const variant of wrong) {
        const response = await client().sell(variant as typeof base, owner, base.saleId, naira);
        expect({ variant, status: response.status, code: code(response.body) }).toEqual({
          variant,
          status: 400,
          code: "VALIDATION_FAILED",
        });
      }
      expect(await effects(naira)).toEqual(before);

      const recorded = sale((await client().sell(base, owner, base.saleId, naira).expect(201)).body);
      expect(recorded).toMatchObject({ currency: "NGN", total: ngn("5000") });

      const kes = await client().pricedItem({ price: "700", tracked: false });
      const shilling = sale(
        (
          await client()
            .sell(client().saleBody([[kes, "1"]]))
            .expect(201)
        ).body,
      );
      expect(shilling).toMatchObject({ currency: "KES", total: client().money("700") });
    });
  });

  describe("conflicts with strict details", () => {
    it("answers PRICE_NOT_SET, PRICE_CHANGED, PRODUCT_ARCHIVED and INSUFFICIENT_STOCK with exact details", async () => {
      const unpricedA = await client().product();
      const unpricedB = await client().product();
      const unpriced = [unpricedA, unpricedB].map((item) => ({ ...item, priceMinor: "1", priceVersion: 1 }));
      const before = await effects();
      const notSet = PriceNotSetErrorEnvelopeSchema.parse(
        (
          await client()
            .sell(
              client().saleBody(
                unpriced.map((item) => [item, "1"] as const),
                [{ method: "CASH", amount: client().money("2") }],
              ),
            )
            .expect(409)
        ).body,
      );
      expect(notSet.error.details).toEqual({ variantIds: unpriced.map((item) => item.variantId).sort() });

      const milk = await client().pricedItem({ price: "50000", stock: "5" });
      const repriced = ProductResponseSchema.parse(
        (
          await client()
            .put(`products/${milk.productId}/price`, {
              expectedVersion: milk.version,
              price: client().money("55000"),
            })
            .expect(200)
        ).body,
      );
      const changed = PriceChangedErrorEnvelopeSchema.parse(
        (
          await client()
            .sell(client().saleBody([[milk, "1"]]))
            .expect(409)
        ).body,
      );
      expect(changed.error.details).toEqual({
        changes: [
          { variantId: milk.variantId, currentPriceMinor: "55000", currentPriceVersion: repriced.priceVersion },
        ],
      });

      const sugar = await client().pricedItem({ price: "20000", stock: "5" });
      await client().archive(sugar);
      const archived = ProductArchivedErrorEnvelopeSchema.parse(
        (
          await client()
            .sell(client().saleBody([[sugar, "1"]]))
            .expect(409)
        ).body,
      );
      expect(archived.error.details).toEqual({ variantIds: [sugar.variantId] });

      const salt = await client().pricedItem({ price: "100", stock: "1" });
      const short = InsufficientStockErrorEnvelopeSchema.parse(
        (
          await client()
            .sell(client().saleBody([[salt, "3"]]))
            .expect(409)
        ).body,
      );
      expect(short.error.details).toEqual({ shortages: [{ variantId: salt.variantId, availableQuantityMinor: "1" }] });

      const after = await effects();
      expect({ sales: after.sales, journalLines: after.journalLines }).toEqual({
        sales: before.sales,
        journalLines: before.journalLines,
      });
      expect(await onHand(salt)).toBe("1");
      expect(JSON.stringify(api.logs)).not.toContain('"currentPriceMinor"');
    });

    it("rejects a foreign or unknown variant as not found", async () => {
      const foreign = await client().pricedItem({ businessId: world.b, owner: world.ownerB, tracked: false });
      const missing = { ...foreign, variantId: MISSING_ID };
      for (const item of [foreign, missing]) {
        const response = await client()
          .sell(client().saleBody([[item, "1"]]))
          .expect(404);
        expect(code(response.body)).toBe("NOT_FOUND");
      }
    });

    it("needs sales:discount for a discount and bounds it by the line", async () => {
      const milk = await client().pricedItem({ price: "50000", tracked: false });
      const sugar = await client().pricedItem({ price: "20000", tracked: false });
      const fixed = (amountMinor: string) => ({ discount: { kind: "FIXED", amount: client().money(amountMinor) } });

      const denied = await client()
        .sell(
          client().saleBody([[milk, "2", fixed("5000")]], [{ method: "CASH", amount: client().money("95000") }]),
          as("CASHIER"),
        )
        .expect(403);
      expect(code(denied.body)).toBe("PERMISSION_DENIED");

      const owner = sale(
        (
          await client()
            .sell(
              client().saleBody(
                [[milk, "2", { discount: { kind: "BASIS_POINTS", basisPoints: 1000 } }]],
                [{ method: "CASH", amount: client().money("90000") }],
              ),
            )
            .expect(201)
        ).body,
      );
      expect(owner).toMatchObject({ grossTotal: client().money("100000"), discountTotal: client().money("10000") });
      expect(owner.lines[0]).toMatchObject({
        discount: { kind: "BASIS_POINTS", basisPoints: 1000 },
        discountAmount: client().money("10000"),
        net: client().money("90000"),
      });

      const manager = sale(
        (
          await client()
            .sell(
              client().saleBody([[milk, "2", fixed("5000")]], [{ method: "CASH", amount: client().money("95000") }]),
              as("MANAGER"),
            )
            .expect(201)
        ).body,
      );
      expect(manager.lines[0]?.discount).toEqual({ kind: "FIXED", amount: client().money("5000") });
      expect(manager.total).toEqual(client().money("95000"));

      const exceeds = DiscountExceedsLineErrorEnvelopeSchema.parse(
        (
          await client()
            .sell(
              client().saleBody(
                [
                  [milk, "1"],
                  [sugar, "1", fixed("20000")],
                ],
                [{ method: "CASH", amount: client().money("50000") }],
              ),
            )
            .expect(409)
        ).body,
      );
      expect(exceeds.error.details).toEqual({ lineNumber: 2 });

      const mismatch = TenderTotalMismatchErrorEnvelopeSchema.parse(
        (
          await client()
            .sell(client().saleBody([[milk, "2"]], [{ method: "CASH", amount: client().money("1") }]))
            .expect(409)
        ).body,
      );
      expect(mismatch.error.details).toEqual({ serverTotalMinor: "100000" });
    });
  });

  describe("keyed idempotency", () => {
    it("requires the key, binds it to the sale ID, replays with 201 and rejects reuse", async () => {
      const milk = await client().pricedItem({ price: "50000", stock: "10" });
      const body = client().saleBody([[milk, "2"]]);

      const missing = await client().sell(body, as("OWNER"), null).expect(400);
      expect(code(missing.body)).toBe("IDEMPOTENCY_KEY_REQUIRED");
      const mismatched = await client().sell(body, as("OWNER"), randomUUID()).expect(400);
      expect(code(mismatched.body)).toBe("VALIDATION_FAILED");
      expect(await salesOf(world.a)).toBe(0);

      const fresh = await client().sell(body).expect(201);
      expect(fresh.headers["idempotent-replayed"]).toBeUndefined();
      const replay = await client().sell(body).expect(201);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(sale(replay.body)).toEqual(sale(fresh.body));
      expect(await onHand(milk)).toBe("8");

      const reused = await client()
        .sell({ ...body, lines: [{ ...body.lines[0], quantity: { quantityMinor: "3", unit: "PIECE" } }] })
        .expect(409);
      expect(code(reused.body)).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(await onHand(milk)).toBe("8");
      expect(await salesOf(world.a)).toBe(1);
      const audit = (await readTenancySnapshot()).businessAudit.filter((row) => row.entityId === body.saleId);
      expect(audit).toHaveLength(1);
    });
  });

  describe("reads and permissions", () => {
    it("shows cost only with inventory:cost-read and limits a cashier to their own sales", async () => {
      const milk = await client().pricedItem({ price: "50000", stock: "10", stockCost: "500000" });
      const byOwner = sale(
        (
          await client()
            .sell(client().saleBody([[milk, "1"]]))
            .expect(201)
        ).body,
      );
      const byCashier = sale(
        (
          await client()
            .sell(client().saleBody([[milk, "1"]]), as("CASHIER"))
            .expect(201)
        ).body,
      );
      const otherCashier = await registerActor(api, `cashier-2-${randomUUID()}`, "Second cashier");
      await tenancyFixtures.insertMembership({
        id: uuidV7IdGenerator.newId("membership"),
        businessId: world.a,
        userId: otherCashier.userId,
        role: "CASHIER",
      });
      const byOther = sale(
        (
          await client()
            .sell(client().saleBody([[milk, "1"]]), otherCashier)
            .expect(201)
        ).body,
      );

      for (const role of ["OWNER", "MANAGER", "ACCOUNTANT"] as const) {
        const list = record(SalesResponseSchema.parse((await client().get("sales", as(role)).expect(200)).body));
        expect(list.items.map((item) => item.saleId)).toEqual([byOwner.saleId, byCashier.saleId, byOther.saleId]);
        const one = sale((await client().get(`sales/${byCashier.saleId}`, as(role)).expect(200)).body);
        expect(one).toMatchObject({ costStatus: "VALUED", cogsTotal: client().money("50000") });
      }

      const own = record(SalesResponseSchema.parse((await client().get("sales", as("CASHIER")).expect(200)).body));
      expect(own.items.map((item) => item.saleId)).toEqual([byCashier.saleId]);
      expect(COST_KEYS.filter((key) => keysDeep(own).has(key))).toEqual([]);
      const mine = sale((await client().get(`sales/${byCashier.saleId}`, as("CASHIER")).expect(200)).body);
      expect(COST_KEYS.filter((key) => keysDeep(mine).has(key))).toEqual([]);
      expect(COST_KEYS.filter((key) => keysDeep(byCashier).has(key))).toEqual([]);
      for (const other of [byOwner.saleId, byOther.saleId]) {
        const hidden = await client().get(`sales/${other}`, as("CASHIER")).expect(404);
        expect(code(hidden.body)).toBe("NOT_FOUND");
      }
    });

    it("denies recording to the accountant and every sales route to the stock keeper", async () => {
      const milk = await client().pricedItem({ price: "50000", stock: "10" });
      const posted = sale(
        (
          await client()
            .sell(client().saleBody([[milk, "1"]]))
            .expect(201)
        ).body,
      );
      const before = await effects();
      const accountant = await client()
        .sell(client().saleBody([[milk, "1"]]), as("ACCOUNTANT"))
        .expect(403);
      expect(code(accountant.body)).toBe("PERMISSION_DENIED");
      const keeper = as("STOCK_KEEPER");
      const responses = [
        await client().sell(client().saleBody([[milk, "1"]]), keeper),
        await client().get("sales", keeper),
        await client().get(`sales/${posted.saleId}`, keeper),
        await client().reverse(posted.saleId, undefined, keeper),
      ];
      expect(responses.map((response) => [response.status, code(response.body)])).toEqual(
        responses.map(() => [403, "PERMISSION_DENIED"]),
      );
      expect(await effects()).toEqual(before);
    });

    it("pages sales by ascending sale ID", async () => {
      const bread = await client().pricedItem({ price: "100", tracked: false });
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        ids.push(
          sale(
            (
              await client()
                .sell(client().saleBody([[bread, "1"]]))
                .expect(201)
            ).body,
          ).saleId,
        );
      }
      const first = record(SalesResponseSchema.parse((await client().get("sales?limit=2").expect(200)).body));
      expect(first.items.map((item) => item.saleId)).toEqual([ids[0], ids[1]]);
      expect(first.nextCursor).not.toBeNull();
      const second = record(
        SalesResponseSchema.parse(
          (
            await client()
              .get(`sales?limit=2&after=${encodeURIComponent(first.nextCursor ?? "")}`)
              .expect(200)
          ).body,
        ),
      );
      expect(second.items.map((item) => item.saleId)).toEqual([ids[2]]);
      expect(second.nextCursor).toBeNull();
      const extra = await client().get("sales?status=POSTED").expect(400);
      expect(code(extra.body)).toBe("VALIDATION_FAILED");
    });

    it("hides other tenants' and other locations' sales and rejects a malformed ID", async () => {
      const foreignItem = await client().pricedItem({ businessId: world.b, owner: world.ownerB, tracked: false });
      const foreignBody = client().saleBody([[foreignItem, "1"]]);
      await client().sell(foreignBody, world.ownerB, foreignBody.saleId, world.b).expect(201);
      const bread = await client().pricedItem({ price: "100", tracked: false });
      const mine = sale(
        (
          await client()
            .sell(client().saleBody([[bread, "1"]]))
            .expect(201)
        ).body,
      );

      for (const path of [`sales/${foreignBody.saleId}`, `sales/${MISSING_ID}`]) {
        expect(code((await client().get(path).expect(404)).body)).toBe("NOT_FOUND");
      }
      expect(code((await client().reverse(foreignBody.saleId).expect(404)).body)).toBe("NOT_FOUND");
      expect(code((await client().get(`sales/${mine.saleId}`, world.ownerB, world.b).expect(404)).body)).toBe(
        "NOT_FOUND",
      );
      const list = record(SalesResponseSchema.parse((await client().get("sales").expect(200)).body));
      expect(list.items.map((item) => item.saleId)).toEqual([mine.saleId]);
      expect(code((await client().get("sales/not-a-uuid").expect(400)).body)).toBe("VALIDATION_FAILED");

      const back = await backStoreContext();
      await expect(api.runtime.services.getSale.execute(back, mine.saleId)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect((await api.runtime.services.listSales.execute(back, {})).items).toEqual([]);
    });
  });

  describe("reversal", () => {
    async function posted(quantity = "2") {
      const milk = await client().pricedItem({ price: "50000", stock: "10", stockCost: "700000" });
      const recorded = sale(
        (
          await client()
            .sell(client().saleBody([[milk, quantity]]))
            .expect(201)
        ).body,
      );
      return { milk, recorded };
    }

    it("reverses the whole sale once, restores stock, replays with 200 and rejects reuse or a second reversal", async () => {
      const { milk, recorded } = await posted();
      expect(await onHand(milk)).toBe("8");
      const key = randomUUID();
      const body = { reason: "Customer returned the goods", tenderUnwoundConfirmed: true };
      const reversed = await client().reverse(recorded.saleId, body, as("OWNER"), key).expect(200);
      expect(reversed.headers["idempotent-replayed"]).toBeUndefined();
      const result = sale(reversed.body);
      expect(result).toMatchObject({
        saleId: recorded.saleId,
        status: "REVERSED",
        reversalTenderUnwoundConfirmed: true,
        total: recorded.total,
        receiptNumber: recorded.receiptNumber,
      });
      expect(result.reversedAt).not.toBeNull();
      expect(await onHand(milk)).toBe("10");

      const replay = await client().reverse(recorded.saleId, body, as("OWNER"), key).expect(200);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(sale(replay.body)).toEqual(result);
      const reused = await client()
        .reverse(recorded.saleId, { ...body, reason: "Another reason" }, as("OWNER"), key)
        .expect(409);
      expect(code(reused.body)).toBe("IDEMPOTENCY_KEY_REUSED");
      const again = await client().reverse(recorded.saleId, body).expect(409);
      expect(code(again.body)).toBe("CONFLICT");
      expect(await onHand(milk)).toBe("10");

      const movements = InventoryMovementsResponseSchema.parse(
        (await client().get(`inventory/items/${milk.variantId}/movements`).expect(200)).body,
      ).items;
      const [reversal, original] = movements;
      expect(original).toMatchObject({
        type: "SALE",
        delta: { quantityMinor: "-2", unit: "PIECE" },
        source: { kind: "SALE", id: recorded.saleId },
        reversesMovementId: null,
      });
      expect(reversal).toMatchObject({
        type: "SALE",
        delta: { quantityMinor: "2", unit: "PIECE" },
        source: { kind: "SALE", id: recorded.saleId },
        reversesMovementId: original?.movementId,
      });
      const audit = (await readTenancySnapshot()).businessAudit.filter((row) => row.entityId === recorded.saleId);
      expect(audit.map((row) => row.action)).toEqual(["sale.recorded", "sale.reversed"]);
    });

    it("requires the key, sales:reverse, a confirmed tender unwind and a bounded reason", async () => {
      const { recorded } = await posted();
      const before = await effects();
      const missing = await client().reverse(recorded.saleId, undefined, as("OWNER"), null).expect(400);
      expect(code(missing.body)).toBe("IDEMPOTENCY_KEY_REQUIRED");
      for (const role of ["CASHIER", "ACCOUNTANT", "STOCK_KEEPER"] as const) {
        const denied = await client().reverse(recorded.saleId, undefined, as(role)).expect(403);
        expect(code(denied.body)).toBe("PERMISSION_DENIED");
      }
      const invalid: Record<string, unknown>[] = [
        { reason: "Returned", tenderUnwoundConfirmed: false },
        { reason: "Returned" },
        { reason: "Returned", tenderUnwoundConfirmed: "true" },
        { reason: "   ", tenderUnwoundConfirmed: true },
        { tenderUnwoundConfirmed: true },
        { reason: "x".repeat(501), tenderUnwoundConfirmed: true },
        { reason: "x".repeat(2001), tenderUnwoundConfirmed: true },
        { reason: "Returned", tenderUnwoundConfirmed: true, refund: client().money("1") },
      ];
      for (const body of invalid) {
        const response = await client().reverse(recorded.saleId, body);
        expect({ body, status: response.status, code: code(response.body) }).toEqual({
          body,
          status: 400,
          code: "VALIDATION_FAILED",
        });
      }
      expect(await effects()).toEqual(before);
      expect(sale((await client().get(`sales/${recorded.saleId}`).expect(200)).body).status).toBe("POSTED");

      sale((await client().reverse(recorded.saleId, undefined, as("MANAGER")).expect(200)).body);
    });

    it("reverses a sale of a product archived since", async () => {
      const { milk, recorded } = await posted("3");
      await client().archive(milk);
      const result = sale((await client().reverse(recorded.saleId).expect(200)).body);
      expect(result.status).toBe("REVERSED");
      expect(await onHand(milk)).toBe("10");
    });
  });

  describe("authentication and device trust", () => {
    it("requires a bearer token on every sales route", async () => {
      expect(SALES_ROUTES).toHaveLength(4);
      for (const route of SALES_ROUTES) {
        const [method, template] = route.split(" ") as [string, string];
        const path = template.replace(":businessId", world.a).replace(":saleId", MISSING_ID);
        const http = client().http();
        const response = await (method === "GET" ? http.get(path) : http.post(path).send({}));
        expect({ route, status: response.status }).toEqual({ route, status: 401 });
      }
    });

    it("rejects every untrusted device on every sales route without writing", async () => {
      const milk = await client().pricedItem({ price: "50000", stock: "10" });
      const posted = sale(
        (
          await client()
            .sell(client().saleBody([[milk, "1"]]))
            .expect(201)
        ).body,
      );
      const call = (route: (typeof SALES_ROUTES)[number], headers: Record<string, string>, body?: unknown) => {
        const [method, template] = route.split(" ") as [string, string];
        const path = template.replace(":businessId", world.a).replace(":saleId", posted.saleId);
        const http = client().http();
        if (method === "GET")
          return http
            .get(path)
            .set(bearer(as("OWNER").token))
            .set(headers);
        const fresh = client().saleBody([[milk, "1"]]);
        const defaultBody = route.endsWith("/reversal") ? { reason: "x", tenderUnwoundConfirmed: true } : fresh;
        return http
          .post(path)
          .set(bearer(as("OWNER").token))
          .set(headers)
          .set("idempotency-key", route.endsWith("/reversal") ? randomUUID() : fresh.saleId)
          .send(body ?? defaultBody);
      };

      const cases = await untrustedDeviceCases(api, as("OWNER"), world.a, { owner: world.ownerB, businessId: world.b });
      const before = await effects();
      for (const [label, headers] of cases) {
        for (const route of SALES_ROUTES) {
          const response = await call(route, headers);
          expect({ label, route, status: response.status, code: code(response.body) }).toEqual({
            label,
            route,
            status: 403,
            code: "DEVICE_NOT_TRUSTED",
          });
        }
      }
      expect(await effects()).toEqual(before);

      const trusted = await registerDevice(api, as("OWNER"), world.a, "Trusted till");
      const afterRegistration = await effects();
      for (const route of SALES_ROUTES) {
        const response = await call(route, trusted.headers, { unexpected: true });
        const expectedStatus = route.startsWith("GET ") ? 200 : 400;
        expect({ route, status: response.status }).toEqual({ route, status: expectedStatus });
      }
      expect(await effects()).toEqual(afterRegistration);
    });
  });
});
