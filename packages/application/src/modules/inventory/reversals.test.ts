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
