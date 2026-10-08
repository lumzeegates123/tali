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
  const rice = await h.product(mine.OWNER, { name: "Rice", stockUnit: "KG" });
  const soap = await h.product(mine.OWNER, { name: "Soap" });
  return { h, mine, theirs, key, rice, soap };
}

describe("RecordOpeningStock", () => {
  it("records one OPENING movement per line, sets balances to version 1 and audits the line count", async () => {
    const { h, mine, key, rice, soap } = await setup();
    const outcome = await h.recordOpeningStock.execute(mine.MANAGER, {
      lines: [
        { variantId: soap.variant.id, quantityMinor: "24", unit: "PIECE" },
        { variantId: rice.variant.id, decimal: "12.5", unit: "KG" },
      ],
      note: "  Counted on the first day ",
      idempotencyKey: key(),
    });
    expect(outcome.replayed).toBe(false);
    expect(outcome.document).toMatchObject({
      kind: "OPENING_BATCH",
      locationId: mine.MANAGER.locationId,
      note: "Counted on the first day",
      status: "POSTED",
      lineCount: 2,
    });
    expect(outcome.movements.map((m) => m.variantId)).toEqual([rice.variant.id, soap.variant.id].sort());
    for (const movement of outcome.movements) {
      expect(movement).toMatchObject({
        type: "OPENING",
        balanceVersion: 1,
        source: { kind: "OPENING_BATCH", id: outcome.document.id },
        locationId: mine.MANAGER.locationId,
      });
    }
    expect(h.stock(mine.OWNER, rice.variant.id)).toBe("12500");
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("24");
    expect(h.inventoryAudit()).toMatchObject([
      {
        action: "inventory.opening_recorded",
        entityType: "inventory_opening_batch",
        entityId: outcome.document.id,
        locationId: mine.MANAGER.locationId,
        payload: { lineCount: 2 },
      },
    ]);
    h.inventory.assertConsistent();
  });

  it("converts a pack line to stock units and keeps the pack snapshot on the movement", async () => {
    const { h, mine, key, soap } = await setup();
    const { pack } = await h.catalog.addPack.execute(mine.OWNER, {
      productId: soap.product.id,
      name: "Carton of 12",
      factorMinor: "12",
      idempotencyKey: key(),
    });
    const outcome = await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, packId: pack.id, packCount: "3" }],
      idempotencyKey: key(),
    });
    expect(outcome.movements[0]?.delta.toMinorUnitsString()).toBe("36");
    expect(outcome.movements[0]?.pack).toEqual({ packId: pack.id, name: "Carton of 12", count: 3n, factorMinor: 12n });
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("36");
  });

  it("is never repeated for a stock item: a second opening is a CONFLICT and writes nothing", async () => {
    const { h, mine, key, soap } = await setup();
    const line = { variantId: soap.variant.id, quantityMinor: "5", unit: "PIECE" };
    await h.recordOpeningStock.execute(mine.OWNER, { lines: [line], idempotencyKey: key() });
    const before = h.state();
    await expect(h.recordOpeningStock.execute(mine.OWNER, { lines: [line], idempotencyKey: key() })).rejects.toThrow(
      ConflictError,
    );
    expect(h.state()).toBe(before);
  });

  it("requires a balance at version 0: stock that already moved cannot take an opening", async () => {
    const { h, mine, key, soap } = await setup();
    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "5", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    const before = h.state();
    await expect(
      h.recordOpeningStock.execute(mine.OWNER, {
        lines: [{ variantId: soap.variant.id, quantityMinor: "5", unit: "PIECE" }],
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(ConflictError);
    expect(h.state()).toBe(before);
  });

  it("rejects archived and untracked products with CONFLICT", async () => {
    const { h, mine, key, soap } = await setup();
    const untracked = await h.product(mine.OWNER, { name: "Service", trackInventory: false });
    await h.catalog.archiveProduct.execute(mine.OWNER, { productId: soap.product.id, expectedVersion: 1 });
    const before = h.state();
    for (const variantId of [soap.variant.id, untracked.variant.id]) {
      await expect(
        h.recordOpeningStock.execute(mine.OWNER, {
          lines: [{ variantId, quantityMinor: "1", unit: "PIECE" }],
          idempotencyKey: key(),
        }),
      ).rejects.toThrow(ConflictError);
    }
    expect(h.state()).toBe(before);
  });

  it("rejects a unit other than the stock unit at the line's path, never converting", async () => {
    const { h, mine, key, rice } = await setup();
    const failure = await h.recordOpeningStock
      .execute(mine.OWNER, {
        lines: [{ variantId: rice.variant.id, quantityMinor: "500", unit: "G" }],
        idempotencyKey: key(),
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).issues).toMatchObject([{ path: ["lines", 0, "unit"] }]);
  });

  it.each([
    ["zero", { quantityMinor: "0", unit: "PIECE" }],
    ["a negative quantity", { quantityMinor: "-3", unit: "PIECE" }],
    ["a zero decimal", { decimal: "0.000", unit: "KG" }],
    ["more decimals than the unit scale", { decimal: "1.5", unit: "PIECE" }],
    ["two quantity forms", { quantityMinor: "3", decimal: "3", unit: "PIECE" }],
    ["no quantity form", { unit: "PIECE" }],
    ["a missing unit", { quantityMinor: "3" }],
    ["a pack line with a unit", { packId: "019a0000-0000-7000-8000-000000000001", packCount: "1", unit: "PIECE" }],
    ["a pack count of zero", { packId: "019a0000-0000-7000-8000-000000000001", packCount: "0" }],
    ["a direction on an opening line", { quantityMinor: "3", unit: "PIECE", direction: "INCREASE" }],
  ])("rejects %s as a validation failure without writing", async (_label, quantity) => {
    const { h, mine, key, soap } = await setup();
    const before = h.state();
    await expect(
      h.recordOpeningStock.execute(mine.OWNER, {
        lines: [{ variantId: soap.variant.id, ...quantity }],
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(ValidationError);
    expect(h.state()).toBe(before);
  });

  it("rejects two lines for the same product rather than merging them", async () => {
    const { h, mine, key, soap } = await setup();
    await expect(
      h.recordOpeningStock.execute(mine.OWNER, {
        lines: [
          { variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" },
          { variantId: soap.variant.id, quantityMinor: "2", unit: "PIECE" },
        ],
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("hides other businesses' products and packs, and malformed IDs, as NOT_FOUND", async () => {
    const { h, mine, theirs, key, soap } = await setup();
    const foreign = await h.product(theirs.OWNER, { name: "Their soap" });
    const { pack: foreignPack } = await h.catalog.addPack.execute(theirs.OWNER, {
      productId: foreign.product.id,
      name: "Box",
      factorMinor: "10",
      idempotencyKey: key(),
    });
    const before = h.state();
    for (const line of [
      { variantId: foreign.variant.id, quantityMinor: "1", unit: "PIECE" },
      { variantId: "not-a-uuid", quantityMinor: "1", unit: "PIECE" },
      { variantId: soap.variant.id, packId: foreignPack.id, packCount: "1" },
      { variantId: soap.variant.id, packId: "not-a-uuid", packCount: "1" },
    ]) {
      await expect(h.recordOpeningStock.execute(mine.OWNER, { lines: [line], idempotencyKey: key() })).rejects.toThrow(
        NotFoundError,
      );
    }
    expect(h.state()).toBe(before);
  });

  it("rejects another product's pack as NOT_FOUND and a retired pack as CONFLICT", async () => {
    const { h, mine, key, soap, rice } = await setup();
    const { pack: ricePack } = await h.catalog.addPack.execute(mine.OWNER, {
      productId: rice.product.id,
      name: "Bag",
      factorMinor: "50000",
      idempotencyKey: key(),
    });
    const { pack: carton } = await h.catalog.addPack.execute(mine.OWNER, {
      productId: soap.product.id,
      name: "Carton",
      factorMinor: "12",
      idempotencyKey: key(),
    });
    await h.catalog.retirePack.execute(mine.OWNER, { packId: carton.id });
    const before = h.state();
    await expect(
      h.recordOpeningStock.execute(mine.OWNER, {
        lines: [{ variantId: soap.variant.id, packId: ricePack.id, packCount: "1" }],
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      h.recordOpeningStock.execute(mine.OWNER, {
        lines: [{ variantId: soap.variant.id, packId: carton.id, packCount: "1" }],
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(ConflictError);
    expect(h.state()).toBe(before);
  });

  it("is allowed to OWNER and MANAGER only", async () => {
    const { h, mine, key, soap } = await setup();
    const before = h.state();
    for (const role of ["STOCK_KEEPER", "CASHIER", "ACCOUNTANT"] as const) {
      await expect(
        h.recordOpeningStock.execute(mine[role], {
          lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
          idempotencyKey: key(),
        }),
      ).rejects.toThrow(PermissionDeniedError);
    }
    expect(h.state()).toBe(before);
    expect(h.calls).toEqual([]);
  });
});
