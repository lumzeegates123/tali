import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
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
  return { h, mine, theirs, key, soap };
}

describe("PostGoodsReceipt", () => {
  it("adds PURCHASE_RECEIPT movements on top of the balance and audits whether a reference was given", async () => {
    const { h, mine, key, soap } = await setup();
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "4", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    const outcome = await h.postGoodsReceipt.execute(mine.STOCK_KEEPER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "20", unit: "PIECE" }],
      reference: " INV-2026-0042 ",
      idempotencyKey: key(),
    });
    expect(outcome.document).toMatchObject({ kind: "GOODS_RECEIPT", reference: "INV-2026-0042", status: "POSTED" });
    expect(outcome.movements).toMatchObject([
      { type: "PURCHASE_RECEIPT", balanceVersion: 2, source: { kind: "GOODS_RECEIPT", id: outcome.document.id } },
    ]);
    expect(outcome.movements[0]?.balanceAfter.toMinorUnitsString()).toBe("24");
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("24");
    expect(h.inventoryAudit().at(-1)).toMatchObject({
      action: "inventory.received",
      entityType: "goods_receipt",
      entityId: outcome.document.id,
      payload: { lineCount: 1, referencePresent: true },
    });
    const plain = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    expect(plain.document.reference).toBeUndefined();
    expect(h.inventoryAudit().at(-1)?.payload).toEqual({ lineCount: 1, referencePresent: false });
    h.inventory.assertConsistent();
  });

  it("receives into a product with no opening stock, starting its balance at version 1", async () => {
    const { h, mine, key, soap } = await setup();
    const outcome = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "6", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    expect(outcome.movements[0]?.balanceVersion).toBe(1);
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("6");
  });

  it("rejects a reference over 64 characters and a blank note", async () => {
    const { h, mine, key, soap } = await setup();
    const line = { variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" };
    const before = h.state();
    await expect(
      h.postGoodsReceipt.execute(mine.OWNER, { lines: [line], reference: "R".repeat(65), idempotencyKey: key() }),
    ).rejects.toThrow(ValidationError);
    await expect(
      h.postGoodsReceipt.execute(mine.OWNER, { lines: [line], note: "   ", idempotencyKey: key() }),
    ).rejects.toThrow(ValidationError);
    expect(h.state()).toBe(before);
    const accepted = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [line],
      reference: "R".repeat(64),
      idempotencyKey: key(),
    });
    expect(accepted.document.reference).toHaveLength(64);
  });

  it("rejects archived and untracked products with CONFLICT and hides other businesses' products", async () => {
    const { h, mine, theirs, key, soap } = await setup();
    const untracked = await h.product(mine.OWNER, { trackInventory: false });
    const foreign = await h.product(theirs.OWNER);
    await h.catalog.archiveProduct.execute(mine.OWNER, { productId: soap.product.id, expectedVersion: 1 });
    const before = h.state();
    for (const variantId of [soap.variant.id, untracked.variant.id]) {
      await expect(
        h.postGoodsReceipt.execute(mine.OWNER, {
          lines: [{ variantId, quantityMinor: "1", unit: "PIECE" }],
          idempotencyKey: key(),
        }),
      ).rejects.toThrow(ConflictError);
    }
    await expect(
      h.postGoodsReceipt.execute(mine.OWNER, {
        lines: [{ variantId: foreign.variant.id, quantityMinor: "1", unit: "PIECE" }],
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(NotFoundError);
    expect(h.state()).toBe(before);
  });

  it("is allowed to OWNER, MANAGER and STOCK_KEEPER; CASHIER and ACCOUNTANT are denied", async () => {
    const { h, mine, key, soap } = await setup();
    for (const role of ["OWNER", "MANAGER", "STOCK_KEEPER"] as const) {
      await h.postGoodsReceipt.execute(mine[role], {
        lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
        idempotencyKey: key(),
      });
    }
    const before = h.state();
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      await expect(
        h.postGoodsReceipt.execute(mine[role], {
          lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
          idempotencyKey: key(),
        }),
      ).rejects.toThrow(PermissionDeniedError);
    }
    expect(h.state()).toBe(before);
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("3");
  });
});
