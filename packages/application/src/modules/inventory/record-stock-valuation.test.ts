import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  IdempotencyKeyReusedError,
  PermissionDeniedError,
  ValuationStaleError,
} from "../../errors/application-error.js";
import { createInventoryHarness } from "../../testing/inventory-harness.js";

describe("RecordStockValuation", () => {
  async function unvaluedOpening(currency: "NGN" | "JPY" = "NGN") {
    const h = createInventoryHarness({
      currencies: [defineCurrency("NGN", 2), defineCurrency("JPY", 0)],
    });
    const mine = await h.businessWithRoles("Mine", currency);
    const soap = await h.product(mine.OWNER, { name: "Soap" });
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" }],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    return { h, mine, soap };
  }

  it("records an INITIAL_OPENING valuation with a journal entry", async () => {
    const { h, mine, soap } = await unvaluedOpening();
    const result = await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "350000", currency: "NGN" },
      reason: "Opening value",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    expect(result.kind).toBe("INITIAL_OPENING");
    expect(result.replayed).toBe(false);
    expect(h.ledger.entries).toHaveLength(1);
    expect(h.ledger.entries[0]?.source.kind).toBe("valuation");
    expect(h.ledger.entries[0]?.lines.map((line) => line.systemRole)).toEqual(["INVENTORY", "OPENING_BALANCE_EQUITY"]);
    expect(h.inventory.valuations[0]?.status).toBe("VALUED");
    expect(h.inventoryAudit().some((row) => row.action === "inventory.valuation_recorded")).toBe(true);
  });

  it("lets MANAGER record an INITIAL_OPENING valuation", async () => {
    const { h, mine, soap } = await unvaluedOpening();
    const result = await h.recordStockValuation.execute(mine.MANAGER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "1000", currency: "NGN" },
      reason: "Counted cost",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    expect(result.kind).toBe("INITIAL_OPENING");
  });

  it.each(["STOCK_KEEPER", "ACCOUNTANT", "CASHIER"] as const)("denies %s before any write", async (role) => {
    const { h, mine, soap } = await unvaluedOpening();
    const before = h.state();
    await expect(
      h.recordStockValuation.execute(mine[role], {
        variantId: soap.variant.id,
        expectedBalanceVersion: 1,
        newTotalValue: { amountMinor: "350000", currency: "NGN" },
        reason: "Opening value",
        idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
      }),
    ).rejects.toThrow(PermissionDeniedError);
    expect(h.state()).toBe(before);
  });

  it("posts an OPERATIONAL increase to INVENTORY_GAIN, never OPENING_BALANCE_EQUITY", async () => {
    const { h, mine, soap } = await unvaluedOpening();
    await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "100000", currency: "NGN" },
      reason: "Initial",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "2", unit: "PIECE" }],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    expect(h.inventory.valuations.find((row) => row.variantId === soap.variant.id)?.status).toBe("UNVALUED");
    const result = await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 2,
      newTotalValue: { amountMinor: "305333", currency: "NGN" },
      reason: "Recounted cost",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    expect(result.kind).toBe("OPERATIONAL");
    const operational = h.ledger.entries.filter((entry) => entry.source.kind === "valuation").at(-1);
    expect(operational?.lines.map((line) => line.systemRole)).toEqual(["INVENTORY", "INVENTORY_GAIN"]);
    expect(operational?.lines.some((line) => line.systemRole === "OPENING_BALANCE_EQUITY")).toBe(false);
  });

  it("posts an OPERATIONAL decrease to INVENTORY_SHRINKAGE", async () => {
    const { h, mine, soap } = await unvaluedOpening();
    await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "100000", currency: "NGN" },
      reason: "Initial",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    const result = await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 2,
      newTotalValue: { amountMinor: "55333", currency: "NGN" },
      reason: "Write down",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    expect(result.kind).toBe("OPERATIONAL");
    const operational = h.ledger.entries.filter((entry) => entry.source.kind === "valuation").at(-1);
    expect(operational?.lines.map((line) => line.systemRole)).toEqual(["INVENTORY_SHRINKAGE", "INVENTORY"]);
  });

  it("writes the document and audit for a zero-difference operational valuation, with no journal", async () => {
    const { h, mine, soap } = await unvaluedOpening();
    await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "100000", currency: "NGN" },
      reason: "Initial",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    const journalsBefore = h.ledger.entries.length;
    const result = await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 2,
      newTotalValue: { amountMinor: "100000", currency: "NGN" },
      reason: "Confirm unchanged",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    expect(result.kind).toBe("OPERATIONAL");
    expect(h.ledger.entries).toHaveLength(journalsBefore);
    expect(h.inventory.stockValuationDocuments.some((row) => row.reason === "Confirm unchanged")).toBe(true);
    expect(h.inventoryAudit().filter((row) => row.action === "inventory.valuation_recorded")).toHaveLength(2);
  });

  it("VALUATION_STALE writes nothing when the balance version moved", async () => {
    const { h, mine, soap } = await unvaluedOpening();
    const before = h.state();
    await expect(
      h.recordStockValuation.execute(mine.OWNER, {
        variantId: soap.variant.id,
        expectedBalanceVersion: 0,
        newTotalValue: { amountMinor: "1", currency: "NGN" },
        reason: "Stale",
        idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
      }),
    ).rejects.toThrow(ValuationStaleError);
    expect(h.state()).toBe(before);
    expect(h.ledger.entries).toHaveLength(0);
  });

  it("rejects an already VALUED item", async () => {
    const { h, mine, soap } = await unvaluedOpening();
    await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "1000", currency: "NGN" },
      reason: "Initial",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    const before = h.state();
    await expect(
      h.recordStockValuation.execute(mine.OWNER, {
        variantId: soap.variant.id,
        expectedBalanceVersion: 1,
        newTotalValue: { amountMinor: "2000", currency: "NGN" },
        reason: "Again",
        idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
      }),
    ).rejects.toThrow(ConflictError);
    expect(h.state()).toBe(before);
  });

  it("replays the same idempotency key and body", async () => {
    const { h, mine, soap } = await unvaluedOpening();
    const key = h.catalog.tenancy.ids.newId("IdempotencyKey");
    const input = {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "350000", currency: "NGN" },
      reason: "Opening value",
      idempotencyKey: key,
    };
    const first = await h.recordStockValuation.execute(mine.OWNER, input);
    const replay = await h.recordStockValuation.execute(mine.OWNER, input);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(h.ledger.entries).toHaveLength(1);
    expect(h.inventory.stockValuationDocuments).toHaveLength(1);
  });

  it("rejects the same key with a different value or reason", async () => {
    const { h, mine, soap } = await unvaluedOpening();
    const key = h.catalog.tenancy.ids.newId("IdempotencyKey");
    await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "350000", currency: "NGN" },
      reason: "Opening value",
      idempotencyKey: key,
    });
    await expect(
      h.recordStockValuation.execute(mine.OWNER, {
        variantId: soap.variant.id,
        expectedBalanceVersion: 1,
        newTotalValue: { amountMinor: "1", currency: "NGN" },
        reason: "Opening value",
        idempotencyKey: key,
      }),
    ).rejects.toThrow(IdempotencyKeyReusedError);
    await expect(
      h.recordStockValuation.execute(mine.OWNER, {
        variantId: soap.variant.id,
        expectedBalanceVersion: 1,
        newTotalValue: { amountMinor: "350000", currency: "NGN" },
        reason: "Different reason",
        idempotencyKey: key,
      }),
    ).rejects.toThrow(IdempotencyKeyReusedError);
  });

  it("uses the server clock for the business date", async () => {
    const h = createInventoryHarness({
      currencies: [defineCurrency("NGN", 2)],
      start: "2026-03-15T23:30:00.000Z",
    });
    const mine = await h.businessWithRoles("Mine", "NGN");
    const soap = await h.product(mine.OWNER, { name: "Soap" });
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    h.catalog.tenancy.clock.set("2026-10-18T07:00:00.000Z");
    await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "10", currency: "NGN" },
      reason: "Server date",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    expect(h.inventory.stockValuationDocuments[0]?.businessDate.toString()).toBe("2026-10-18");
    expect(h.ledger.entries[0]?.businessDate).toBe("2026-10-18");
  });

  it("records a non-NGN business currency", async () => {
    const { h, mine, soap } = await unvaluedOpening("JPY");
    const result = await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "250", currency: "JPY" },
      reason: "Yen cost",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    expect(result.kind).toBe("INITIAL_OPENING");
    expect(h.inventory.valuations[0]?.value.currency).toBe("JPY");
    expect(h.ledger.entries[0]?.currency).toBe("JPY");
  });
});
