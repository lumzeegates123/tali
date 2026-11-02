import { defineCurrency, type MembershipRole } from "@tali/domain";
import { describe, expect, it } from "vitest";
import type { LocationBoundContext } from "../../context/business-context.js";
import { createSalesHarness, type SalesHarness } from "../../testing/sales-harness.js";
import type { RecordSaleInput } from "./record-sale.js";

const CURRENCIES = [defineCurrency("NGN", 2)];

function harness(): SalesHarness {
  return createSalesHarness({ currencies: CURRENCIES, start: "2026-10-30T12:00:00.000Z" });
}

type Roles = Readonly<Record<MembershipRole, LocationBoundContext>>;

async function pricedProduct(
  h: SalesHarness,
  owner: LocationBoundContext,
  props: {
    readonly price?: string;
    readonly tracked?: boolean;
    readonly unit?: string;
    readonly quantityMinor?: bigint;
    readonly valueMinor?: bigint;
    readonly status?: "VALUED" | "UNVALUED";
  } = {},
) {
  const created = await h.product(owner, {
    trackInventory: props.tracked ?? true,
    ...(props.unit === undefined ? {} : { stockUnit: props.unit }),
  });
  const priceVersion = await h.price(owner, created.productId, 1, props.price ?? "50000");
  if (props.tracked !== false) {
    h.putStock(owner, created.variantId, {
      quantityMinor: props.quantityMinor ?? 10n,
      valueMinor: props.valueMinor ?? 350_000n,
      status: props.status ?? "VALUED",
    });
  }
  return { ...created, priceVersion };
}

function saleInput(
  h: SalesHarness,
  variantId: string,
  priceVersion: number,
  overrides: Partial<RecordSaleInput> & { readonly quantityMinor?: string; readonly unit?: string } = {},
): RecordSaleInput {
  const saleId = h.catalog.tenancy.ids.newId("Sale");
  const quantityMinor = overrides.quantityMinor ?? "2";
  const unit = overrides.unit ?? "PIECE";
  return {
    saleId,
    idempotencyKey: saleId,
    lines: overrides.lines ?? [{ variantId, quantityMinor, unit, expectedPriceVersion: priceVersion }],
    tenders: overrides.tenders ?? [{ method: "CASH", amountMinor: "100000" }],
    ...(overrides.deviceReportedAt === undefined ? {} : { deviceReportedAt: overrides.deviceReportedAt }),
  };
}

async function rejection(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("expected the sale call to fail");
}

describe("RecordSale", () => {
  it("posts a valued cash sale, issues S-000001, and replays without a second effect", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const product = await pricedProduct(h, roles.OWNER);
    const input = saleInput(h, product.variantId, product.priceVersion, {
      deviceReportedAt: "2020-01-01T00:00:00.000Z",
    });
    const first = await h.recordSale.execute(roles.OWNER, input);
    expect(first.replayed).toBe(false);
    expect(first.sale).toMatchObject({
      receiptNumber: "S-000001",
      status: "POSTED",
      totalMinor: "100000",
      taxTotalMinor: "0",
      costStatus: "VALUED",
      cogsTotalMinor: "70000",
      businessDate: "2026-10-30",
      deviceReportedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(first.sale.lines[0]).toMatchObject({
      lineNumber: 1,
      unitPriceMinor: "50000",
      costStatus: "VALUED",
      costMinor: "70000",
      taxKind: "NONE",
    });
    expect(h.salesStore.stockOf(roles.OWNER.businessId, roles.OWNER.locationId, product.variantId)).toMatchObject({
      quantityMinor: 8n,
      valueMinor: 280_000n,
      valuationStatus: "VALUED",
    });
    const entry = h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId)[0];
    expect(entry).toMatchObject({
      entryKind: "ORIGINAL",
      source: { kind: "sale", id: input.saleId },
      postingRule: "SALE_POSTED",
      postingRuleVersion: 1,
      businessDate: "2026-10-30",
    });
    expect(entry?.lines.map((line) => [line.systemRole, line.direction, line.amount.amountMinor])).toEqual([
      ["CASH_ON_HAND", "DEBIT", 100_000n],
      ["SALES_REVENUE", "CREDIT", 100_000n],
      ["COST_OF_GOODS_SOLD", "DEBIT", 70_000n],
      ["INVENTORY", "CREDIT", 70_000n],
    ]);
    const audit = h.saleAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "sale.recorded",
      entityType: "sale",
      entityId: input.saleId,
      payload: {
        receiptNumber: "S-000001",
        lineCount: 1,
        tenderCount: 1,
        totalMinor: "100000",
        discountTotalMinor: "0",
        taxTotalMinor: "0",
        costStatus: "VALUED",
        journalEntryId: entry?.id,
      },
    });
    expect(audit[0]?.payload).not.toHaveProperty("lines");
    expect(audit[0]?.reason).toBeUndefined();

    const replay = await h.recordSale.execute(roles.OWNER, input);
    expect(replay.replayed).toBe(true);
    expect(replay.sale.receiptNumber).toBe("S-000001");
    expect(h.salesStore.receiptSequence(roles.OWNER.businessId)).toBe(2n);
    expect(h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId)).toHaveLength(1);
    expect(h.saleAudit()).toHaveLength(1);
    expect(h.salesStore.stockOf(roles.OWNER.businessId, roles.OWNER.locationId, product.variantId)?.quantityMinor).toBe(
      8n,
    );
  });

  it("numbers receipts per business and does not consume a number when the sale fails", async () => {
    const h = harness();
    const first = await h.businessWithRoles("One");
    const second = await h.businessWithRoles("Two");
    const left = await pricedProduct(h, first.OWNER);
    const right = await pricedProduct(h, second.OWNER);
    const posted = await h.recordSale.execute(first.OWNER, saleInput(h, left.variantId, left.priceVersion));
    expect(posted.sale.receiptNumber).toBe("S-000001");
    const other = await h.recordSale.execute(second.OWNER, saleInput(h, right.variantId, right.priceVersion));
    expect(other.sale.receiptNumber).toBe("S-000001");
    const next = await h.recordSale.execute(first.OWNER, saleInput(h, left.variantId, left.priceVersion));
    expect(next.sale.receiptNumber).toBe("S-000002");

    h.salesStore.failures.failNext("sales.insert");
    const failed = await rejection(h.recordSale.execute(first.OWNER, saleInput(h, left.variantId, left.priceVersion)));
    expect(failed).toBeInstanceOf(Error);
    expect(h.salesStore.receiptSequence(first.OWNER.businessId)).toBe(3n);
    const recovered = await h.recordSale.execute(first.OWNER, saleInput(h, left.variantId, left.priceVersion));
    expect(recovered.sale.receiptNumber).toBe("S-000003");
  });

  it.each([["sales.insert"], ["sales.inventory.applySalePlan"], ["ledger.journals.insert"], ["audit.sale.recorded"]])(
    "rolls back a failure at %s",
    async (operation) => {
      const h = harness();
      const roles = await h.businessWithRoles("Shop");
      const product = await pricedProduct(h, roles.OWNER);
      if (operation.startsWith("sales.")) h.salesStore.failures.failNext(operation);
      else if (operation.startsWith("ledger.")) h.catalog.tenancy.ledger.failures.failNext(operation);
      else h.catalog.tenancy.auditWriter.failures.failNext(operation);
      const input = saleInput(h, product.variantId, product.priceVersion);
      await expect(h.recordSale.execute(roles.OWNER, input)).rejects.toThrow(Error);
      expect(h.salesStore.stockOf(roles.OWNER.businessId, roles.OWNER.locationId, product.variantId)).toMatchObject({
        quantityMinor: 10n,
        valueMinor: 350_000n,
      });
      expect(h.salesStore.receiptSequence(roles.OWNER.businessId)).toBe(1n);
      expect(h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId)).toHaveLength(0);
      expect(h.saleAudit()).toHaveLength(0);
      const retry = await h.recordSale.execute(roles.OWNER, input);
      expect(retry.sale.receiptNumber).toBe("S-000001");
    },
  );

  it("rejects a missing price, a changed price and an archived product before any write", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const unpriced = await h.product(roles.OWNER);
    h.putStock(roles.OWNER, unpriced.variantId, { quantityMinor: 10n, valueMinor: 0n, status: "VALUED" });
    const missing = await rejection(
      h.recordSale.execute(
        roles.OWNER,
        saleInput(h, unpriced.variantId, 1, { tenders: [{ method: "CASH", amountMinor: "1" }] }),
      ),
    );
    expect(missing).toMatchObject({ code: "PRICE_NOT_SET" });

    const changed = await pricedProduct(h, roles.OWNER);
    await h.catalog.setSellingPrice.execute(roles.OWNER, {
      productId: changed.productId,
      expectedVersion: 2,
      price: { amountMinor: "60000", currency: "NGN" },
    });
    const other = await pricedProduct(h, roles.OWNER, { price: "1000" });
    const stale = await rejection(
      h.recordSale.execute(roles.OWNER, {
        ...saleInput(h, changed.variantId, changed.priceVersion),
        lines: [
          { variantId: other.variantId, quantityMinor: "1", unit: "PIECE", expectedPriceVersion: other.priceVersion },
          { variantId: changed.variantId, quantityMinor: "2", unit: "PIECE", expectedPriceVersion: 1 },
        ],
        tenders: [{ method: "CASH", amountMinor: "121000" }],
      }),
    );
    expect(stale).toMatchObject({
      code: "PRICE_CHANGED",
      changes: [{ variantId: changed.variantId, currentPriceMinor: "60000", currentPriceVersion: 2 }],
    });
    expect(h.salesStore.stockOf(roles.OWNER.businessId, roles.OWNER.locationId, other.variantId)?.quantityMinor).toBe(
      10n,
    );
    expect(h.saleAudit()).toHaveLength(0);

    const archived = await pricedProduct(h, roles.OWNER);
    await h.catalog.archiveProduct.execute(roles.OWNER, { productId: archived.productId, expectedVersion: 2 });
    const gone = await rejection(
      h.recordSale.execute(roles.OWNER, saleInput(h, archived.variantId, archived.priceVersion)),
    );
    expect(gone).toMatchObject({ code: "PRODUCT_ARCHIVED" });
    expect(h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId)).toHaveLength(0);
  });

  it("rejects a unit mismatch, a short stock position and a missing ledger role with nothing written", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const product = await pricedProduct(h, roles.OWNER);
    const unit = await rejection(
      h.recordSale.execute(roles.OWNER, saleInput(h, product.variantId, product.priceVersion, { unit: "KG" })),
    );
    expect(unit).toMatchObject({ code: "VALIDATION_FAILED" });
    const short = await pricedProduct(h, roles.OWNER, { quantityMinor: 1n });
    const stock = await rejection(h.recordSale.execute(roles.OWNER, saleInput(h, short.variantId, short.priceVersion)));
    expect(stock).toMatchObject({
      code: "INSUFFICIENT_STOCK",
      shortages: [{ variantId: short.variantId, availableQuantityMinor: "1" }],
    });
    h.catalog.tenancy.ledger.removeRole(roles.OWNER.businessId, "CASH_ON_HAND");
    const ledger = await rejection(
      h.recordSale.execute(roles.OWNER, saleInput(h, product.variantId, product.priceVersion)),
    );
    expect(ledger).toMatchObject({ code: "LEDGER_NOT_PROVISIONED" });
    expect(h.salesStore.stockOf(roles.OWNER.businessId, roles.OWNER.locationId, product.variantId)?.quantityMinor).toBe(
      10n,
    );
    expect(h.salesStore.receiptSequence(roles.OWNER.businessId)).toBe(1n);
  });

  it("sells an untracked product with no stock effect and NOT_APPLICABLE cost", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const product = await pricedProduct(h, roles.OWNER, { tracked: false });
    const result = await h.recordSale.execute(roles.OWNER, saleInput(h, product.variantId, product.priceVersion));
    expect(result.sale.costStatus).toBe("NOT_APPLICABLE");
    expect(result.sale.cogsTotalMinor).toBe("0");
    expect(result.sale.lines[0]).toMatchObject({ costStatus: "NOT_APPLICABLE", tracked: false });
    expect(result.sale.lines[0]).not.toHaveProperty("costMinor");
    expect(h.salesStore.stockOf(roles.OWNER.businessId, roles.OWNER.locationId, product.variantId)).toBeUndefined();
    const entry = h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId)[0];
    expect(entry?.lines.map((line) => line.systemRole)).toEqual(["CASH_ON_HAND", "SALES_REVENUE"]);
  });

  it("sells unvalued stock without COGS and keeps a stale recorded value", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const product = await pricedProduct(h, roles.OWNER, { status: "UNVALUED", valueMinor: 999n });
    const result = await h.recordSale.execute(roles.OWNER, saleInput(h, product.variantId, product.priceVersion));
    expect(result.sale).toMatchObject({ costStatus: "UNVALUED", cogsTotalMinor: "0", totalMinor: "100000" });
    expect(result.sale.lines[0]).toMatchObject({ costStatus: "UNVALUED" });
    expect(result.sale.lines[0]).not.toHaveProperty("costMinor");
    expect(h.salesStore.stockOf(roles.OWNER.businessId, roles.OWNER.locationId, product.variantId)).toMatchObject({
      quantityMinor: 8n,
      valueMinor: 999n,
      valuationStatus: "UNVALUED",
    });
    expect(
      h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId)[0]?.lines.map((line) => line.systemRole),
    ).toEqual(["CASH_ON_HAND", "SALES_REVENUE"]);
  });

  it("aggregates mixed lines and applies duplicate variants sequentially", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const valued = await pricedProduct(h, roles.OWNER);
    const unvalued = await pricedProduct(h, roles.OWNER, { status: "UNVALUED", valueMinor: 50n, quantityMinor: 4n });
    const untracked = await pricedProduct(h, roles.OWNER, { tracked: false, price: "1000" });
    const mixed = await h.recordSale.execute(roles.OWNER, {
      ...saleInput(h, valued.variantId, valued.priceVersion),
      lines: [
        { variantId: valued.variantId, quantityMinor: "2", unit: "PIECE", expectedPriceVersion: valued.priceVersion },
        {
          variantId: unvalued.variantId,
          quantityMinor: "1",
          unit: "PIECE",
          expectedPriceVersion: unvalued.priceVersion,
        },
        {
          variantId: untracked.variantId,
          quantityMinor: "3",
          unit: "PIECE",
          expectedPriceVersion: untracked.priceVersion,
        },
      ],
      tenders: [{ method: "CASH", amountMinor: "153000" }],
    });
    expect(mixed.sale.costStatus).toBe("PARTIAL");
    expect(mixed.sale.cogsTotalMinor).toBe("70000");
    expect(mixed.sale.lines.map((line) => line.lineNumber)).toEqual([1, 2, 3]);

    const same = await pricedProduct(h, roles.OWNER, { quantityMinor: 3n, valueMinor: 100n, price: "10" });
    const sequential = await h.recordSale.execute(roles.OWNER, {
      ...saleInput(h, same.variantId, same.priceVersion),
      lines: [
        { variantId: same.variantId, quantityMinor: "2", unit: "PIECE", expectedPriceVersion: same.priceVersion },
        { variantId: same.variantId, quantityMinor: "1", unit: "PIECE", expectedPriceVersion: same.priceVersion },
      ],
      tenders: [{ method: "CASH", amountMinor: "30" }],
    });
    expect(sequential.sale.lines.map((line) => line.costMinor)).toEqual(["67", "33"]);
    expect(h.salesStore.stockOf(roles.OWNER.businessId, roles.OWNER.locationId, same.variantId)).toMatchObject({
      quantityMinor: 0n,
      valueMinor: 0n,
    });
  });

  it("rejects empty and oversized lines and tenders, and accepts the bounds", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const product = await pricedProduct(h, roles.OWNER, {
      quantityMinor: 200n,
      valueMinor: 0n,
      status: "UNVALUED",
      price: "100",
    });
    await expect(
      h.recordSale.execute(roles.OWNER, { ...saleInput(h, product.variantId, product.priceVersion), lines: [] }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      h.recordSale.execute(roles.OWNER, {
        ...saleInput(h, product.variantId, product.priceVersion),
        lines: Array.from({ length: 201 }, () => ({
          variantId: product.variantId,
          quantityMinor: "1",
          unit: "PIECE",
          expectedPriceVersion: product.priceVersion,
        })),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      h.recordSale.execute(roles.OWNER, { ...saleInput(h, product.variantId, product.priceVersion), tenders: [] }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      h.recordSale.execute(roles.OWNER, {
        ...saleInput(h, product.variantId, product.priceVersion),
        tenders: Array.from({ length: 11 }, () => ({ method: "CASH", amountMinor: "1" })),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const manyLines = await h.recordSale.execute(roles.OWNER, {
      ...saleInput(h, product.variantId, product.priceVersion),
      lines: Array.from({ length: 200 }, () => ({
        variantId: product.variantId,
        quantityMinor: "1",
        unit: "PIECE",
        expectedPriceVersion: product.priceVersion,
      })),
      tenders: [{ method: "CASH", amountMinor: "20000" }],
    });
    expect(manyLines.sale.lines).toHaveLength(200);
    expect(manyLines.sale.lines[199]?.lineNumber).toBe(200);

    const wide = await pricedProduct(h, roles.OWNER, { price: "100000" });
    const manyTenders = await h.recordSale.execute(roles.OWNER, {
      ...saleInput(h, wide.variantId, wide.priceVersion, { quantityMinor: "1" }),
      tenders: Array.from({ length: 10 }, (_, index) => ({
        method: index % 2 === 0 ? "CASH" : "BANK_TRANSFER",
        amountMinor: "10000",
      })),
    });
    expect(manyTenders.sale.tenders.map((tender) => tender.tenderNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const entry = h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId).at(-1);
    const cash = entry?.lines.filter((line) => line.systemRole === "CASH_ON_HAND") ?? [];
    expect(cash).toHaveLength(1);
    expect(cash[0]?.direction).toBe("DEBIT");
    expect(cash[0]?.amount.amountMinor).toBe(50_000n);
  });

  it("snapshots cash change and rejects a short or misplaced cash received", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const product = await pricedProduct(h, roles.OWNER);
    const exact = await h.recordSale.execute(roles.OWNER, {
      ...saleInput(h, product.variantId, product.priceVersion),
      tenders: [{ method: "CASH", amountMinor: "100000", cashReceivedMinor: "100000" }],
    });
    expect(exact.sale.tenders[0]).toMatchObject({ cashReceivedMinor: "100000", changeGivenMinor: "0" });
    const change = await h.recordSale.execute(roles.OWNER, {
      ...saleInput(h, product.variantId, product.priceVersion),
      tenders: [{ method: "CASH", amountMinor: "100000", cashReceivedMinor: "120000" }],
    });
    expect(change.sale.tenders[0]?.changeGivenMinor).toBe("20000");
    const debit = h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId).at(-1)?.lines[0];
    expect(debit?.amount.amountMinor).toBe(100_000n);
    const plain = await h.recordSale.execute(roles.OWNER, saleInput(h, product.variantId, product.priceVersion));
    expect(plain.sale.tenders[0]).not.toHaveProperty("cashReceivedMinor");
    await expect(
      h.recordSale.execute(roles.OWNER, {
        ...saleInput(h, product.variantId, product.priceVersion),
        tenders: [{ method: "CASH", amountMinor: "100000", cashReceivedMinor: "100" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      h.recordSale.execute(roles.OWNER, {
        ...saleInput(h, product.variantId, product.priceVersion),
        tenders: [{ method: "BANK_TRANSFER", amountMinor: "100000", cashReceivedMinor: "100000" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(h.salesStore.receiptSequence(roles.OWNER.businessId)).toBe(4n);
  });

  it("enforces discount permission and the discount bounds", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const product = await pricedProduct(h, roles.OWNER);
    const discounted = {
      ...saleInput(h, product.variantId, product.priceVersion),
      lines: [
        {
          variantId: product.variantId,
          quantityMinor: "2",
          unit: "PIECE",
          expectedPriceVersion: product.priceVersion,
          discount: { kind: "FIXED" as const, amountMinor: "1000" },
        },
      ],
      tenders: [{ method: "CASH", amountMinor: "99000" }],
    };
    await expect(h.recordSale.execute(roles.CASHIER, discounted)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const owner = await h.recordSale.execute(roles.OWNER, discounted);
    expect(owner.sale.discountTotalMinor).toBe("1000");
    const manager = await h.recordSale.execute(roles.MANAGER, {
      ...saleInput(h, product.variantId, product.priceVersion),
      lines: [
        {
          variantId: product.variantId,
          quantityMinor: "2",
          unit: "PIECE",
          expectedPriceVersion: product.priceVersion,
          discount: { kind: "BASIS_POINTS" as const, basisPoints: 1000 },
        },
      ],
      tenders: [{ method: "CASH", amountMinor: "90000" }],
    });
    expect(manager.sale.lines[0]?.discountMinor).toBe("10000");
    const entry = h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId).at(-1);
    expect(entry?.lines.find((line) => line.systemRole === "SALES_DISCOUNTS")?.amount.amountMinor).toBe(10_000n);
    expect(entry?.lines.find((line) => line.systemRole === "SALES_REVENUE")?.amount.amountMinor).toBe(100_000n);

    for (const discount of [
      { kind: "FIXED" as const, amountMinor: "0" },
      { kind: "FIXED" as const, amountMinor: "100000" },
      { kind: "FIXED" as const, amountMinor: "100001" },
      { kind: "BASIS_POINTS" as const, basisPoints: 0 },
      { kind: "BASIS_POINTS" as const, basisPoints: 10_000 },
    ]) {
      const error = await rejection(
        h.recordSale.execute(roles.OWNER, {
          ...saleInput(h, product.variantId, product.priceVersion),
          lines: [
            {
              variantId: product.variantId,
              quantityMinor: "2",
              unit: "PIECE",
              expectedPriceVersion: product.priceVersion,
              discount,
            },
          ],
        }),
      );
      expect(error).toMatchObject({ code: "DISCOUNT_EXCEEDS_LINE" });
    }
    const tiny = await pricedProduct(h, roles.OWNER, {
      price: "1",
      quantityMinor: 5n,
      valueMinor: 0n,
      status: "UNVALUED",
    });
    const rounded = await rejection(
      h.recordSale.execute(roles.OWNER, {
        ...saleInput(h, tiny.variantId, tiny.priceVersion),
        lines: [
          {
            variantId: tiny.variantId,
            quantityMinor: "1",
            unit: "PIECE",
            expectedPriceVersion: tiny.priceVersion,
            discount: { kind: "BASIS_POINTS", basisPoints: 9999 },
          },
        ],
        tenders: [{ method: "CASH", amountMinor: "1" }],
      }),
    );
    expect(rounded).toMatchObject({ code: "DISCOUNT_EXCEEDS_LINE", lineNumber: 1 });
  });

  it("accepts every tender method, aggregates duplicates, and rejects a total mismatch", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const product = await pricedProduct(h, roles.OWNER, { quantityMinor: 20n });
    for (const method of ["CASH", "BANK_TRANSFER", "POS_CARD", "OTHER"] as const) {
      const result = await h.recordSale.execute(roles.OWNER, {
        ...saleInput(h, product.variantId, product.priceVersion),
        tenders: [{ method, amountMinor: "100000", ...(method === "BANK_TRANSFER" ? { reference: "TRF-1" } : {}) }],
      });
      expect(result.sale.tenders[0]?.method).toBe(method);
      if (method === "CASH") expect(result.sale.tenders[0]?.verificationStatus).toBe("NOT_APPLICABLE");
      else expect(result.sale.tenders[0]?.verificationStatus).toBe("NOT_VERIFIED");
    }
    const split = await h.recordSale.execute(roles.OWNER, {
      ...saleInput(h, product.variantId, product.priceVersion),
      tenders: [
        { method: "CASH", amountMinor: "60000" },
        { method: "CASH", amountMinor: "20000" },
        { method: "BANK_TRANSFER", amountMinor: "20000" },
      ],
    });
    expect(split.sale.tenders).toHaveLength(3);
    const cashLines = h.catalog.tenancy.ledger
      .entriesFor(roles.OWNER.businessId)
      .at(-1)
      ?.lines.filter((line) => line.systemRole === "CASH_ON_HAND");
    expect(cashLines).toHaveLength(1);
    expect(cashLines?.[0]?.amount.amountMinor).toBe(80_000n);
    await expect(
      h.recordSale.execute(roles.OWNER, {
        ...saleInput(h, product.variantId, product.priceVersion),
        tenders: [{ method: "CASH", amountMinor: "1" }],
      }),
    ).rejects.toMatchObject({ code: "TENDER_TOTAL_MISMATCH" });
    await expect(
      h.recordSale.execute(roles.OWNER, {
        ...saleInput(h, product.variantId, product.priceVersion),
        tenders: [{ method: "CASH", amountMinor: "100001" }],
      }),
    ).rejects.toMatchObject({ code: "TENDER_TOTAL_MISMATCH" });
    await expect(
      h.recordSale.execute(roles.OWNER, {
        ...saleInput(h, product.variantId, product.priceVersion),
        tenders: [{ method: "CASH", amountMinor: "0" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("requires the idempotency key to equal the UUIDv7 sale id", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const product = await pricedProduct(h, roles.OWNER);
    const input = saleInput(h, product.variantId, product.priceVersion);
    await expect(h.recordSale.execute(roles.OWNER, { ...input, idempotencyKey: undefined })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
    await expect(
      h.recordSale.execute(roles.OWNER, { ...input, idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey") }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      h.recordSale.execute(roles.OWNER, { ...input, saleId: "01900000-0000-4000-8000-000000000001" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await h.recordSale.execute(roles.OWNER, input);
    await expect(
      h.recordSale.execute(roles.OWNER, { ...input, tenders: [{ method: "BANK_TRANSFER", amountMinor: "100000" }] }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId)).toHaveLength(1);
  });
});

describe("sale reads", () => {
  it("scopes reads by role and hides cost from a cashier", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const other = await h.businessWithRoles("Other");
    const product = await pricedProduct(h, roles.OWNER);
    const ownerSale = await h.recordSale.execute(roles.OWNER, saleInput(h, product.variantId, product.priceVersion));
    const cashierSale = await h.recordSale.execute(
      roles.CASHIER,
      saleInput(h, product.variantId, product.priceVersion),
    );
    expect(ownerSale.sale.costStatus).toBe("VALUED");
    expect(cashierSale.sale).not.toHaveProperty("costStatus");
    expect(cashierSale.sale).not.toHaveProperty("cogsTotalMinor");
    expect(cashierSale.sale.lines[0]).not.toHaveProperty("costMinor");
    expect(cashierSale.sale.lines[0]).not.toHaveProperty("costStatus");

    expect((await h.getSale.execute(roles.OWNER, ownerSale.sale.saleId)).saleId).toBe(ownerSale.sale.saleId);
    expect((await h.getSale.execute(roles.MANAGER, cashierSale.sale.saleId)).costStatus).toBe("VALUED");
    expect((await h.getSale.execute(roles.ACCOUNTANT, ownerSale.sale.saleId)).cogsTotalMinor).toBe("70000");
    await expect(h.getSale.execute(roles.CASHIER, ownerSale.sale.saleId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await h.getSale.execute(roles.CASHIER, cashierSale.sale.saleId)).costStatus).toBeUndefined();
    await expect(h.getSale.execute(roles.STOCK_KEEPER, ownerSale.sale.saleId)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(h.getSale.execute(other.OWNER, ownerSale.sale.saleId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const elsewhere = { ...roles.OWNER, locationId: h.catalog.tenancy.ids.newId("Location") };
    await expect(h.getSale.execute(elsewhere, ownerSale.sale.saleId)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const ownerList = await h.listSales.execute(roles.OWNER);
    expect(ownerList.items.map((sale) => sale.saleId).sort()).toEqual(
      [ownerSale.sale.saleId, cashierSale.sale.saleId].sort(),
    );
    expect((await h.listSales.execute(roles.MANAGER)).items).toHaveLength(2);
    expect((await h.listSales.execute(roles.ACCOUNTANT)).items).toHaveLength(2);
    const own = await h.listSales.execute(roles.CASHIER);
    expect(own.items.map((sale) => sale.saleId)).toEqual([cashierSale.sale.saleId]);
    expect(own.items[0]).not.toHaveProperty("cogsTotalMinor");
    await expect(h.listSales.execute(roles.STOCK_KEEPER)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect((await h.listSales.execute(elsewhere)).items).toHaveLength(0);
  });
});

describe("ReverseSale", () => {
  async function posted(h: SalesHarness, roles: Roles) {
    const product = await pricedProduct(h, roles.OWNER);
    const sale = await h.recordSale.execute(roles.OWNER, saleInput(h, product.variantId, product.priceVersion));
    return { product, sale };
  }

  it("reverses the journal and restores the snapshotted cost, including after archive", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const { product, sale } = await posted(h, roles);
    await h.catalog.archiveProduct.execute(roles.OWNER, { productId: product.productId, expectedVersion: 2 });
    h.catalog.tenancy.clock.advanceBySeconds(20 * 60 * 60);
    const key = h.catalog.tenancy.ids.newId("IdempotencyKey");
    const reversed = await h.reverseSale.execute(roles.MANAGER, {
      saleId: sale.sale.saleId,
      reason: "  customer changed their mind  ",
      tenderUnwoundConfirmed: true,
      idempotencyKey: key,
    });
    expect(reversed.replayed).toBe(false);
    expect(reversed.sale).toMatchObject({
      status: "REVERSED",
      reversalTenderUnwoundConfirmed: true,
      businessDate: "2026-10-30",
    });
    expect(h.salesStore.stockOf(roles.OWNER.businessId, roles.OWNER.locationId, product.variantId)).toMatchObject({
      quantityMinor: 10n,
      valueMinor: 350_000n,
      valuationStatus: "VALUED",
    });
    const entries = h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId);
    expect(entries).toHaveLength(2);
    const original = entries[0];
    const mirror = entries[1];
    expect(mirror).toMatchObject({
      entryKind: "REVERSAL",
      source: { kind: "sale", id: sale.sale.saleId },
      reversesEntryId: original?.id,
      businessDate: "2026-10-31",
    });
    expect(mirror?.lines.map((line) => [line.systemRole, line.direction, line.amount.amountMinor])).toEqual(
      original?.lines.map((line) => [
        line.systemRole,
        line.direction === "DEBIT" ? "CREDIT" : "DEBIT",
        line.amount.amountMinor,
      ]),
    );
    const audit = h.saleAudit().find((record) => record.action === "sale.reversed");
    expect(audit).toMatchObject({
      reason: "customer changed their mind",
      payload: {
        receiptNumber: "S-000001",
        reversalJournalEntryId: mirror?.id,
        tenderUnwoundConfirmed: true,
      },
    });
    expect(audit?.payload).not.toHaveProperty("lines");
    const replay = await h.reverseSale.execute(roles.MANAGER, {
      saleId: sale.sale.saleId,
      reason: "customer changed their mind",
      tenderUnwoundConfirmed: true,
      idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
    expect(h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId)).toHaveLength(2);
    expect(h.saleAudit().filter((record) => record.action === "sale.reversed")).toHaveLength(1);
  });

  it("keeps an unvalued reversal unvalued and adds no value when the original line had no cost", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const product = await pricedProduct(h, roles.OWNER, { status: "UNVALUED", valueMinor: 999n });
    const sale = await h.recordSale.execute(roles.OWNER, saleInput(h, product.variantId, product.priceVersion));
    await h.reverseSale.execute(roles.OWNER, {
      saleId: sale.sale.saleId,
      reason: "void",
      tenderUnwoundConfirmed: true,
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    expect(h.salesStore.stockOf(roles.OWNER.businessId, roles.OWNER.locationId, product.variantId)).toMatchObject({
      quantityMinor: 10n,
      valueMinor: 999n,
      valuationStatus: "UNVALUED",
    });
    const reversal = h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId)[1];
    expect(reversal?.lines.map((line) => line.systemRole)).toEqual(["CASH_ON_HAND", "SALES_REVENUE"]);
  });

  it("conflicts on a second key, reuses a changed body, and rolls back a failed reversal", async () => {
    const h = harness();
    const roles = await h.businessWithRoles("Shop");
    const other = await h.businessWithRoles("Other");
    const { product, sale } = await posted(h, roles);
    const key = h.catalog.tenancy.ids.newId("IdempotencyKey");
    await expect(
      h.reverseSale.execute(roles.OWNER, {
        saleId: sale.sale.saleId,
        reason: " ",
        tenderUnwoundConfirmed: true,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      h.reverseSale.execute(roles.OWNER, {
        saleId: sale.sale.saleId,
        reason: "x".repeat(501),
        tenderUnwoundConfirmed: true,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      h.reverseSale.execute(roles.OWNER, {
        saleId: sale.sale.saleId,
        reason: "void",
        tenderUnwoundConfirmed: false,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      h.reverseSale.execute(roles.CASHIER, {
        saleId: sale.sale.saleId,
        reason: "void",
        tenderUnwoundConfirmed: true,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      h.reverseSale.execute(other.OWNER, {
        saleId: sale.sale.saleId,
        reason: "void",
        tenderUnwoundConfirmed: true,
        idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const elsewhere = { ...roles.OWNER, locationId: h.catalog.tenancy.ids.newId("Location") };
    await expect(
      h.reverseSale.execute(elsewhere, {
        saleId: sale.sale.saleId,
        reason: "void",
        tenderUnwoundConfirmed: true,
        idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.salesStore.stockOf(roles.OWNER.businessId, roles.OWNER.locationId, product.variantId)?.quantityMinor).toBe(
      8n,
    );

    await h.reverseSale.execute(roles.OWNER, {
      saleId: sale.sale.saleId,
      reason: "void",
      tenderUnwoundConfirmed: true,
      idempotencyKey: key,
    });
    await expect(
      h.reverseSale.execute(roles.OWNER, {
        saleId: sale.sale.saleId,
        reason: "void",
        tenderUnwoundConfirmed: true,
        idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      h.reverseSale.execute(roles.OWNER, {
        saleId: sale.sale.saleId,
        reason: "different reason",
        tenderUnwoundConfirmed: true,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId)).toHaveLength(2);
  });

  it.each(["sales.inventory.applyReversalPlan", "ledger.journals.insert", "audit.sale.reversed"])(
    "leaves the sale posted when %s fails",
    async (operation) => {
      const h = harness();
      const roles = await h.businessWithRoles("Shop");
      const { product, sale } = await posted(h, roles);
      if (operation.startsWith("sales.")) h.salesStore.failures.failNext(operation);
      else if (operation.startsWith("ledger.")) h.catalog.tenancy.ledger.failures.failNext(operation);
      else h.catalog.tenancy.auditWriter.failures.failNext(operation);
      const key = h.catalog.tenancy.ids.newId("IdempotencyKey");
      await expect(
        h.reverseSale.execute(roles.OWNER, {
          saleId: sale.sale.saleId,
          reason: "void",
          tenderUnwoundConfirmed: true,
          idempotencyKey: key,
        }),
      ).rejects.toThrow(Error);
      expect((await h.getSale.execute(roles.OWNER, sale.sale.saleId)).status).toBe("POSTED");
      expect(
        h.salesStore.stockOf(roles.OWNER.businessId, roles.OWNER.locationId, product.variantId)?.quantityMinor,
      ).toBe(8n);
      expect(h.catalog.tenancy.ledger.entriesFor(roles.OWNER.businessId)).toHaveLength(1);
      expect(h.saleAudit().some((record) => record.action === "sale.reversed")).toBe(false);
      const recovered = await h.reverseSale.execute(roles.OWNER, {
        saleId: sale.sale.saleId,
        reason: "void",
        tenderUnwoundConfirmed: true,
        idempotencyKey: key,
      });
      expect(recovered.sale.status).toBe("REVERSED");
    },
  );
});
