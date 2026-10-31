import type { CatalogProduct } from "@tali/domain";
import { defineCurrency, restoreLocation } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  InsufficientStockError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "../../errors/application-error.js";
import { planMovementValuations } from "./valuation-posting.js";
import { createInventoryHarness } from "../../testing/inventory-harness.js";

async function setup() {
  const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2), defineCurrency("KES", 2)] });
  const mine = await h.businessWithRoles("Mine", "NGN");
  const theirs = await h.businessWithRoles("Theirs", "KES");
  const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
  const soap = await h.product(mine.OWNER, { name: "Soap" });
  const oil = await h.product(mine.OWNER, { name: "Oil" });
  const receiptInput = {
    lines: [
      { variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" },
      { variantId: oil.variant.id, quantityMinor: "4", unit: "PIECE" },
    ],
    reference: "INV-7",
    idempotencyKey: key(),
  };
  const receipt = await h.postGoodsReceipt.execute(mine.OWNER, receiptInput);
  return { h, mine, theirs, key, soap, oil, receipt, receiptInput };
}

describe("ReverseGoodsReceipt", () => {
  it("negates every original line, marks the receipt REVERSED and audits the reason", async () => {
    const { h, mine, soap, oil, receipt } = await setup();
    const result = await h.reverseGoodsReceipt.execute(mine.MANAGER, {
      documentId: receipt.document.id,
      reason: " Wrong supplier delivery ",
    });
    expect(result.changed).toBe(true);
    expect(result.document).toMatchObject({
      id: receipt.document.id,
      status: "REVERSED",
      reversalReason: "Wrong supplier delivery",
      reversedByMembershipId: mine.MANAGER.actor.type === "user" ? mine.MANAGER.actor.membershipId : undefined,
    });
    expect(result.reversalMovements).toHaveLength(2);
    for (const [index, reversal] of result.reversalMovements.entries()) {
      const original = receipt.movements[index];
      expect(reversal).toMatchObject({
        type: "PURCHASE_RECEIPT",
        variantId: original?.variantId,
        reversesMovementId: original?.id,
        source: { kind: "GOODS_RECEIPT", id: receipt.document.id },
        reasonNote: "Wrong supplier delivery",
        balanceVersion: 2,
      });
      expect(reversal.pack).toBeUndefined();
      expect(original && reversal.delta.equals(original.delta.negate())).toBe(true);
    }
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("0");
    expect(h.stock(mine.OWNER, oil.variant.id)).toBe("0");
    expect(h.inventoryAudit().at(-1)).toMatchObject({
      action: "inventory.receipt_reversed",
      entityType: "goods_receipt",
      entityId: receipt.document.id,
      reason: "Wrong supplier delivery",
      payload: { lineCount: 2 },
    });
    h.inventory.assertConsistent();
  });

  it("treats reversing a REVERSED receipt as a no-op: no movement, no audit", async () => {
    const { h, mine, receipt } = await setup();
    await h.reverseGoodsReceipt.execute(mine.OWNER, { documentId: receipt.document.id, reason: "Duplicate" });
    const before = h.state();
    const again = await h.reverseGoodsReceipt.execute(mine.OWNER, { documentId: receipt.document.id, reason: "Again" });
    expect(again).toMatchObject({ changed: false, reversalMovements: [], document: { status: "REVERSED" } });
    expect(again.document.reversalReason).toBe("Duplicate");
    expect(h.state()).toBe(before);
  });

  it("hides malformed, unknown, foreign and other-location receipts as NOT_FOUND", async () => {
    const { h, mine, theirs, receipt } = await setup();
    const now = h.catalog.tenancy.clock.now();
    const backStore = restoreLocation({
      id: h.catalog.tenancy.ids.newId("Location"),
      businessId: mine.OWNER.businessId,
      name: "Back store",
      isDefault: false,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    h.catalog.tenancy.store.putLocation(backStore);
    const before = h.state();
    for (const [context, documentId] of [
      [mine.OWNER, "not-a-uuid"],
      [mine.OWNER, h.catalog.tenancy.ids.newId("GoodsReceipt")],
      [theirs.OWNER, receipt.document.id],
      [{ ...mine.OWNER, locationId: backStore.id }, receipt.document.id],
    ] as const) {
      await expect(h.reverseGoodsReceipt.execute(context, { documentId, reason: "x" })).rejects.toThrow(NotFoundError);
    }
    expect(h.state()).toBe(before);
  });

  it("refuses with INSUFFICIENT_STOCK when the received stock is no longer on hand", async () => {
    const { h, mine, key, soap, receipt } = await setup();
    await h.recordWriteOff.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "6", unit: "PIECE" }],
      reasonCode: "DAMAGED",
      idempotencyKey: key(),
    });
    const before = h.state();
    await expect(
      h.reverseGoodsReceipt.execute(mine.OWNER, { documentId: receipt.document.id, reason: "Returned" }),
    ).rejects.toThrow(InsufficientStockError);
    expect(h.state()).toBe(before);
    expect(h.inventory.receipts[0]?.status).toBe("POSTED");
  });

  it("reverses for an archived product; a product that stopped tracking inventory is a CONFLICT", async () => {
    const { h, mine, soap, oil, receipt } = await setup();
    await h.catalog.archiveProduct.execute(mine.OWNER, { productId: soap.product.id, expectedVersion: 1 });
    const stored = h.catalog.catalog.products.find((item) => item.variant.id === oil.variant.id);
    if (stored === undefined) throw new Error("missing product");
    const untracked: CatalogProduct = { ...stored, variant: { ...stored.variant, trackInventory: false } };
    h.catalog.catalog.putProduct(untracked);
    const before = h.state();
    await expect(
      h.reverseGoodsReceipt.execute(mine.OWNER, { documentId: receipt.document.id, reason: "Wrong" }),
    ).rejects.toThrow(ConflictError);
    expect(h.state()).toBe(before);
    h.catalog.catalog.putProduct(stored);
    const result = await h.reverseGoodsReceipt.execute(mine.OWNER, {
      documentId: receipt.document.id,
      reason: "Wrong",
    });
    expect(result.changed).toBe(true);
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("0");
  });

  it.each([
    ["a missing reason", undefined],
    ["a blank reason", "   "],
    ["a reason over 500 characters", "r".repeat(501)],
  ])("rejects %s", async (_label, reason) => {
    const { h, mine, receipt } = await setup();
    const before = h.state();
    await expect(
      h.reverseGoodsReceipt.execute(mine.OWNER, { documentId: receipt.document.id, reason: reason as string }),
    ).rejects.toThrow(ValidationError);
    expect(h.state()).toBe(before);
  });

  it("is allowed to OWNER and MANAGER only", async () => {
    const { h, mine, receipt } = await setup();
    const before = h.state();
    for (const role of ["STOCK_KEEPER", "CASHIER", "ACCOUNTANT"] as const) {
      await expect(
        h.reverseGoodsReceipt.execute(mine[role], { documentId: receipt.document.id, reason: "x" }),
      ).rejects.toThrow(PermissionDeniedError);
    }
    expect(h.state()).toBe(before);
  });

  it("still replays the original receipt key with its POSTED snapshot and original movements only", async () => {
    const { h, mine, receipt, receiptInput } = await setup();
    await h.reverseGoodsReceipt.execute(mine.OWNER, { documentId: receipt.document.id, reason: "Wrong" });
    const replay = await h.postGoodsReceipt.execute(mine.OWNER, receiptInput);
    expect(replay).toEqual({ ...receipt, replayed: true });
    expect(replay.document.status).toBe("POSTED");
    expect(replay.movements.every((m) => m.reversesMovementId === undefined)).toBe(true);
  });
});

describe("ReverseAdjustment", () => {
  it("reverses an adjustment's increases and decreases exactly, auditing the kind", async () => {
    const { h, mine, key, soap, oil } = await setup();
    const adjustment = await h.recordAdjustment.execute(mine.OWNER, {
      lines: [
        { variantId: soap.variant.id, quantityMinor: "3", unit: "PIECE", direction: "DECREASE" },
        { variantId: oil.variant.id, quantityMinor: "2", unit: "PIECE", direction: "INCREASE" },
      ],
      reasonCode: "DATA_ENTRY_CORRECTION",
      idempotencyKey: key(),
    });
    const result = await h.reverseAdjustment.execute(mine.OWNER, {
      documentId: adjustment.document.id,
      reason: "Counted again",
    });
    expect(result.changed).toBe(true);
    expect(result.reversalMovements.every((m) => m.type === "ADJUSTMENT" && m.reasonCode === undefined)).toBe(true);
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("10");
    expect(h.stock(mine.OWNER, oil.variant.id)).toBe("4");
    expect(h.inventoryAudit().at(-1)).toMatchObject({
      action: "inventory.adjustment_reversed",
      entityType: "inventory_adjustment",
      reason: "Counted again",
      payload: { kind: "ADJUSTMENT", lineCount: 2 },
    });
    h.inventory.assertConsistent();
  });

  it("reverses a write-off back onto the balance; a repeat is a no-op", async () => {
    const { h, mine, key, soap } = await setup();
    const writeOff = await h.recordWriteOff.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "4", unit: "PIECE" }],
      reasonCode: "THEFT_OR_LOSS",
      idempotencyKey: key(),
    });
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("6");
    await h.reverseAdjustment.execute(mine.OWNER, { documentId: writeOff.document.id, reason: "Found it" });
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("10");
    expect(h.inventoryAudit().at(-1)?.payload).toEqual({ kind: "WRITE_OFF", lineCount: 1 });
    const before = h.state();
    expect(
      (await h.reverseAdjustment.execute(mine.OWNER, { documentId: writeOff.document.id, reason: "Again" })).changed,
    ).toBe(false);
    expect(h.state()).toBe(before);
  });

  it("refuses with INSUFFICIENT_STOCK when a reversed increase is no longer on hand", async () => {
    const { h, mine, key, soap } = await setup();
    const found = await h.recordAdjustment.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "5", unit: "PIECE", direction: "INCREASE" }],
      reasonCode: "FOUND_STOCK",
      idempotencyKey: key(),
    });
    await h.recordWriteOff.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "12", unit: "PIECE" }],
      reasonCode: "SPOILED",
      idempotencyKey: key(),
    });
    const before = h.state();
    await expect(
      h.reverseAdjustment.execute(mine.OWNER, { documentId: found.document.id, reason: "Not found after all" }),
    ).rejects.toThrow(InsufficientStockError);
    expect(h.state()).toBe(before);
  });

  it("hides receipts, foreign adjustments and malformed IDs as NOT_FOUND; denies STOCK_KEEPER", async () => {
    const { h, mine, theirs, key, soap, receipt } = await setup();
    const adjustment = await h.recordWriteOff.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
      reasonCode: "DAMAGED",
      idempotencyKey: key(),
    });
    const before = h.state();
    for (const [context, documentId] of [
      [mine.OWNER, receipt.document.id],
      [mine.OWNER, "nope"],
      [theirs.OWNER, adjustment.document.id],
    ] as const) {
      await expect(h.reverseAdjustment.execute(context, { documentId, reason: "x" })).rejects.toThrow(NotFoundError);
    }
    await expect(
      h.reverseAdjustment.execute(mine.STOCK_KEEPER, { documentId: adjustment.document.id, reason: "x" }),
    ).rejects.toThrow(PermissionDeniedError);
    expect(h.state()).toBe(before);
  });
});

describe("legacy and exact inventory reversal valuation", () => {
  it("turns VALUED to UNVALUED when reversing a NOT_VALUED original, keeping value and posting no journal", async () => {
    const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2)] });
    const mine = await h.businessWithRoles("Mine", "NGN");
    const soap = await h.product(mine.OWNER, { name: "Soap" });
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" }],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "500000", currency: "NGN" },
      reason: "Opening value",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    const receipt = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "4", unit: "PIECE" }],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    const valued = h.inventory.valuations.find((row) => row.variantId === soap.variant.id);
    expect(valued?.status).toBe("UNVALUED");
    await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 2,
      newTotalValue: { amountMinor: "500000", currency: "NGN" },
      reason: "Revalued after costless receipt",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    expect(h.inventory.valuations.find((row) => row.variantId === soap.variant.id)?.status).toBe("VALUED");
    const journals = h.ledger.entries.length;
    const result = await h.reverseGoodsReceipt.execute(mine.OWNER, {
      documentId: receipt.document.id,
      reason: "Returned the uncosted delivery",
    });
    expect(result.changed).toBe(true);
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("10");
    const after = h.inventory.valuations.find((row) => row.variantId === soap.variant.id);
    expect(after?.status).toBe("UNVALUED");
    expect(after?.value.toMinorUnitsString()).toBe("500000");
    const reversalFact = h.inventory.movementValuations.find(
      (row) => row.movementId === result.reversalMovements[0]?.id,
    );
    expect(reversalFact).toMatchObject({ costBasis: "NOT_VALUED", valueDeltaMinor: 0n });
    expect(reversalFact?.journalEntryId).toBeUndefined();
    expect(h.ledger.entries).toHaveLength(journals);
  });

  it("keeps UNVALUED when reversing a costless original that never became VALUED", async () => {
    const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2)] });
    const mine = await h.businessWithRoles("Mine", "NGN");
    const soap = await h.product(mine.OWNER, { name: "Soap" });
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" }],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    const receipt = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "4", unit: "PIECE" }],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    expect(h.inventory.valuations.find((row) => row.variantId === soap.variant.id)?.status).toBe("UNVALUED");
    const journals = h.ledger.entries.length;
    const result = await h.reverseGoodsReceipt.execute(mine.OWNER, {
      documentId: receipt.document.id,
      reason: "Returned the uncosted delivery",
    });
    expect(result.changed).toBe(true);
    const after = h.inventory.valuations.find((row) => row.variantId === soap.variant.id);
    expect(after?.status).toBe("UNVALUED");
    expect(after?.value.toMinorUnitsString()).toBe("0");
    expect(h.ledger.entries).toHaveLength(journals);
  });

  it("does not create a residual merely because a legacy reversal becomes UNVALUED", async () => {
    const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2)] });
    const mine = await h.businessWithRoles("Mine", "NGN");
    const soap = await h.product(mine.OWNER, { name: "Soap" });
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" }],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "500000", currency: "NGN" },
      reason: "Opening value",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    const receipt = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "4", unit: "PIECE" }],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    await h.recordStockValuation.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 2,
      newTotalValue: { amountMinor: "500000", currency: "NGN" },
      reason: "Revalued after costless receipt",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    await h.reverseGoodsReceipt.execute(mine.OWNER, {
      documentId: receipt.document.id,
      reason: "Returned the uncosted delivery",
    });
    expect(h.inventory.stockValuationDocuments.filter((row) => row.kind === "REVERSAL_RESIDUAL")).toHaveLength(0);
  });
});

describe("exact reversal residual policy (ADR-009 section 26.1)", () => {
  it("creates no residual when the exact reversal leaves a valid valued projection", async () => {
    const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2)] });
    const mine = await h.businessWithRoles("Mine", "NGN");
    const soap = await h.product(mine.OWNER, { name: "Soap" });
    const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "10",
          unit: "PIECE",
          totalCost: { amountMinor: "1000", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    const receipt = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "10",
          unit: "PIECE",
          totalCost: { amountMinor: "500", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    const originalFact = h.inventory.movementValuations.find((row) => row.movementId === receipt.movements[0]?.id);
    const journalsBefore = h.ledger.entries.length;
    const result = await h.reverseGoodsReceipt.execute(mine.OWNER, {
      documentId: receipt.document.id,
      reason: "Returned the delivery",
    });
    const reversalFact = h.inventory.movementValuations.find(
      (row) => row.movementId === result.reversalMovements[0]?.id,
    );
    expect(reversalFact?.costBasis).toBe("REVERSAL_OF_ORIGINAL");
    expect(reversalFact?.valueDeltaMinor).toBe(-(originalFact?.valueDeltaMinor ?? 0n));
    expect(reversalFact?.valueAfter.toMinorUnitsString()).toBe("1000");
    expect(h.inventory.stockValuationDocuments.filter((row) => row.kind === "REVERSAL_RESIDUAL")).toHaveLength(0);
    const reversalJournals = h.ledger.entries.filter((entry) => entry.entryKind === "REVERSAL");
    expect(reversalJournals).toHaveLength(1);
    expect(h.ledger.entries).toHaveLength(journalsBefore + 1);
    expect(h.inventory.valuations.find((row) => row.variantId === soap.variant.id)?.value.toMinorUnitsString()).toBe(
      "1000",
    );
  });

  it("Case B: exact reversal then a separate ORIGINAL residual when raw value would be negative", async () => {
    const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2)] });
    const mine = await h.businessWithRoles("Mine", "NGN");
    const soap = await h.product(mine.OWNER, { name: "Soap" });
    const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "20",
          unit: "PIECE",
          totalCost: { amountMinor: "100", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    const receipt = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "5",
          unit: "PIECE",
          totalCost: { amountMinor: "500", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    await h.recordWriteOff.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "15", unit: "PIECE" }],
      reasonCode: "SPOILED",
      idempotencyKey: key(),
    });
    const originalFact = h.inventory.movementValuations.find((row) => row.movementId === receipt.movements[0]?.id);
    const journalsBefore = h.ledger.entries.length;
    const result = await h.reverseGoodsReceipt.execute(mine.OWNER, {
      documentId: receipt.document.id,
      reason: "Returned after write-off",
    });
    expect(result.changed).toBe(true);
    const reversal = result.reversalMovements[0];
    const reversalFact = h.inventory.movementValuations.find((row) => row.movementId === reversal?.id);
    expect(reversalFact?.costBasis).toBe("REVERSAL_OF_ORIGINAL");
    expect(reversalFact?.valueDeltaMinor).toBe(-(originalFact?.valueDeltaMinor ?? 0n));
    expect(reversalFact?.valueAfter.isNegative()).toBe(true);
    expect(reversalFact?.valueAfter.toMinorUnitsString()).toBe("-260");
    const residual = h.inventory.stockValuationDocuments.filter((row) => row.kind === "REVERSAL_RESIDUAL");
    expect(residual).toHaveLength(1);
    expect(residual[0]?.triggerMovementId).toBe(reversal?.id);
    expect(residual[0]?.previousValue.toMinorUnitsString()).toBe("-260");
    expect(residual[0]?.newValue.toMinorUnitsString()).toBe("0");
    const reversalJournal = h.ledger.entries.find(
      (entry) => entry.entryKind === "REVERSAL" && entry.source.kind === "goods_receipt",
    );
    const residualJournal = h.ledger.entries.find((entry) => entry.id === residual[0]?.journalEntryId);
    expect(reversalJournal).toBeDefined();
    expect(residualJournal).toMatchObject({
      entryKind: "ORIGINAL",
      postingRule: "INVENTORY_REVERSAL_RESIDUAL",
      postingRuleVersion: 1,
      source: { kind: "valuation", id: residual[0]?.id },
    });
    expect(residualJournal?.lines.map((line) => [line.systemRole, line.direction, line.amount.amountMinor])).toEqual([
      ["INVENTORY", "DEBIT", 260n],
      ["INVENTORY_GAIN", "CREDIT", 260n],
    ]);
    expect(reversalJournal?.id).not.toBe(residualJournal?.id);
    expect(h.ledger.entries).toHaveLength(journalsBefore + 2);
    const after = h.inventory.valuations.find((row) => row.variantId === soap.variant.id);
    expect(after?.value.toMinorUnitsString()).toBe("0");
    expect(after?.status).toBe("VALUED");
    expect(
      h
        .inventoryAudit()
        .some((row) => row.action === "inventory.valuation_recorded" && row.entityId === residual[0]?.id),
    ).toBe(true);
    const replay = await h.reverseGoodsReceipt.execute(mine.OWNER, {
      documentId: receipt.document.id,
      reason: "Returned after write-off",
    });
    expect(replay.changed).toBe(false);
    expect(h.inventory.stockValuationDocuments.filter((row) => row.kind === "REVERSAL_RESIDUAL")).toHaveLength(1);
    expect(h.ledger.entries).toHaveLength(journalsBefore + 2);
  });

  it("Case C: exact reversal then a separate ORIGINAL residual when VALUED zero qty has leftover value", async () => {
    const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2)] });
    const mine = await h.businessWithRoles("Mine", "NGN");
    const soap = await h.product(mine.OWNER, { name: "Soap" });
    const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "10",
          unit: "PIECE",
          totalCost: { amountMinor: "1000", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    const receipt = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "10",
          unit: "PIECE",
          totalCost: { amountMinor: "500", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    await h.recordWriteOff.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" }],
      reasonCode: "SPOILED",
      idempotencyKey: key(),
    });
    const result = await h.reverseGoodsReceipt.execute(mine.OWNER, {
      documentId: receipt.document.id,
      reason: "Returned leftover value",
    });
    const reversal = result.reversalMovements[0];
    const reversalFact = h.inventory.movementValuations.find((row) => row.movementId === reversal?.id);
    expect(reversalFact?.valueAfter.toMinorUnitsString()).toBe("250");
    const residual = h.inventory.stockValuationDocuments.filter((row) => row.kind === "REVERSAL_RESIDUAL");
    expect(residual).toHaveLength(1);
    expect(residual[0]?.triggerMovementId).toBe(reversal?.id);
    const residualJournal = h.ledger.entries.find((entry) => entry.id === residual[0]?.journalEntryId);
    expect(residualJournal?.lines.map((line) => [line.systemRole, line.direction, line.amount.amountMinor])).toEqual([
      ["INVENTORY_SHRINKAGE", "DEBIT", 250n],
      ["INVENTORY", "CREDIT", 250n],
    ]);
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("0");
    const after = h.inventory.valuations.find((row) => row.variantId === soap.variant.id);
    expect(after?.value.toMinorUnitsString()).toBe("0");
    expect(after?.status).toBe("VALUED");
    const replay = await h.reverseGoodsReceipt.execute(mine.OWNER, {
      documentId: receipt.document.id,
      reason: "Returned leftover value",
    });
    expect(replay.changed).toBe(false);
    expect(h.inventory.stockValuationDocuments.filter((row) => row.kind === "REVERSAL_RESIDUAL")).toHaveLength(1);
  });

  it("plans a residual without putting residual lines on the reversal posting plan", async () => {
    const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2)] });
    const mine = await h.businessWithRoles("Mine", "NGN");
    const soap = await h.product(mine.OWNER, { name: "Soap" });
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "20",
          unit: "PIECE",
          totalCost: { amountMinor: "100", currency: "NGN" },
        },
      ],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    const receipt = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "5",
          unit: "PIECE",
          totalCost: { amountMinor: "500", currency: "NGN" },
        },
      ],
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    await h.recordWriteOff.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "15", unit: "PIECE" }],
      reasonCode: "SPOILED",
      idempotencyKey: h.catalog.tenancy.ids.newId("IdempotencyKey"),
    });
    const original = receipt.movements[0];
    const originalFact = h.inventory.movementValuations.find((row) => row.movementId === original?.id);
    const projection = h.inventory.valuations.find((row) => row.variantId === soap.variant.id);
    if (original === undefined || originalFact === undefined || projection === undefined) {
      throw new Error("expected a valued receipt movement and projection");
    }
    const reversal = Object.freeze({
      ...original,
      id: h.catalog.tenancy.ids.newId("InventoryMovement"),
      reversesMovementId: original.id,
      delta: original.delta.negate(),
      balanceAfter: original.balanceAfter.add(original.delta.negate()),
      balanceVersion: original.balanceVersion + 1,
    });
    const planned = planMovementValuations({
      movements: [reversal],
      currentByVariant: new Map([[soap.variant.id, projection]]),
      preQuantityByVariant: new Map([[soap.variant.id, 10n]]),
      costsByVariant: new Map(),
      originalFacts: new Map([[original.id, originalFact]]),
      now: original.occurredAt,
    });
    expect(planned[0]?.postingLines).toEqual([]);
    expect(planned[0]?.residual?.kind).toBe("NEGATIVE_VALUE");
    expect(planned[0]?.fact.valueAfter.isNegative()).toBe(true);
    expect(planned[0]?.next.value.isZero()).toBe(true);
  });
});
