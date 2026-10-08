import { defineCurrency, Quantity } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  VersionConflictError,
} from "../../errors/application-error.js";
import { createInventoryHarness } from "../../testing/inventory-harness.js";

async function setup() {
  const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2), defineCurrency("KES", 2)] });
  const mine = await h.businessWithRoles("Mine", "NGN");
  const theirs = await h.businessWithRoles("Theirs", "KES");
  const rice = await h.product(mine.OWNER, { name: "Rice", stockUnit: "KG" });
  return { h, mine, theirs, rice };
}

function inventoryRows(h: ReturnType<typeof createInventoryHarness>) {
  return JSON.stringify({ movements: h.inventory.movements.length, balances: h.inventory.balances.length });
}

describe("SetLowStockThreshold", () => {
  it("creates version 1 from expectedVersion 0, audits it, and moves no stock", async () => {
    const { h, mine, rice } = await setup();
    const rows = inventoryRows(h);
    const result = await h.setLowStockThreshold.execute(mine.STOCK_KEEPER, {
      variantId: rice.variant.id,
      expectedVersion: 0,
      threshold: { decimal: "2.5", unit: "KG" },
    });
    expect(result.changed).toBe(true);
    expect(result).toMatchObject({
      variantId: rice.variant.id,
      locationId: mine.STOCK_KEEPER.locationId,
      version: 1,
    });
    expect(result.threshold?.equals(Quantity.ofMinor(2_500n, rice.variant.stockUnit))).toBe(true);
    expect(h.inventoryAudit()).toMatchObject([
      {
        action: "inventory.low_stock_threshold_set",
        entityType: "inventory_stock_threshold",
        locationId: mine.STOCK_KEEPER.locationId,
        payload: { variantId: rice.variant.id, stockUnit: "KG", toThresholdMinor: "2500" },
      },
    ]);
    expect(h.inventoryAudit()[0]?.payload).not.toHaveProperty("fromThresholdMinor");
    expect(inventoryRows(h)).toBe(rows);
  });

  it("changes with the current version, auditing from and to; the same value is a no-op", async () => {
    const { h, mine, rice } = await setup();
    const input = { variantId: rice.variant.id, threshold: { quantityMinor: "2000", unit: "KG" } };
    await h.setLowStockThreshold.execute(mine.OWNER, { ...input, expectedVersion: 0 });
    const before = h.state();
    const same = await h.setLowStockThreshold.execute(mine.OWNER, {
      ...input,
      expectedVersion: 1,
      threshold: { decimal: "2", unit: "KG" },
    });
    expect(same).toMatchObject({ changed: false, version: 1 });
    expect(h.state()).toBe(before);
    const changed = await h.setLowStockThreshold.execute(mine.OWNER, {
      ...input,
      expectedVersion: 1,
      threshold: { quantityMinor: "0", unit: "KG" },
    });
    expect(changed).toMatchObject({ changed: true, version: 2 });
    expect(changed.threshold?.isZero()).toBe(true);
    expect(h.inventoryAudit().at(-1)?.payload).toEqual({
      variantId: rice.variant.id,
      stockUnit: "KG",
      fromThresholdMinor: "2000",
      toThresholdMinor: "0",
    });
  });

  it("rejects a stale expectedVersion with VERSION_CONFLICT, even for the current value", async () => {
    const { h, mine, rice } = await setup();
    const input = { variantId: rice.variant.id, threshold: { quantityMinor: "2000", unit: "KG" } };
    await h.setLowStockThreshold.execute(mine.OWNER, { ...input, expectedVersion: 0 });
    const before = h.state();
    for (const expectedVersion of [0, 2]) {
      await expect(h.setLowStockThreshold.execute(mine.OWNER, { ...input, expectedVersion })).rejects.toThrow(
        VersionConflictError,
      );
    }
    expect(h.state()).toBe(before);
  });

  it("returns VERSION_CONFLICT when a concurrent creator commits first", async () => {
    const { h, mine, rice } = await setup();
    const now = Quantity.ofMinor(500n, rice.variant.stockUnit);
    h.inventory.beforeInsertIfAbsent = (threshold) => {
      h.inventory.putThreshold({ ...threshold, id: h.catalog.tenancy.ids.newId("StockThreshold"), threshold: now });
    };
    await expect(
      h.setLowStockThreshold.execute(mine.OWNER, {
        variantId: rice.variant.id,
        expectedVersion: 0,
        threshold: { quantityMinor: "2000", unit: "KG" },
      }),
    ).rejects.toThrow(VersionConflictError);
    expect(h.calls.filter((call) => call.startsWith("thresholds."))).toEqual([
      "thresholds.findForUpdate",
      "thresholds.insertIfAbsent",
      "thresholds.findForUpdate",
    ]);
    expect(h.inventory.thresholds).toHaveLength(1);
    expect(h.inventory.thresholds[0]?.threshold?.equals(now)).toBe(true);
    expect(h.inventoryAudit()).toEqual([]);
  });

  it.each([
    ["a pack", { packId: "019a0000-0000-7000-8000-000000000001", packCount: "1", unit: "KG" }],
    ["another unit", { quantityMinor: "500", unit: "G" }],
    ["a negative value", { quantityMinor: "-1", unit: "KG" }],
    ["two forms", { quantityMinor: "1", decimal: "1", unit: "KG" }],
    ["no unit", { quantityMinor: "1" }],
    ["too many decimals", { decimal: "1.0005", unit: "KG" }],
  ])("rejects %s as a validation failure", async (_label, threshold) => {
    const { h, mine, rice } = await setup();
    const before = h.state();
    await expect(
      h.setLowStockThreshold.execute(mine.OWNER, {
        variantId: rice.variant.id,
        expectedVersion: 0,
        threshold: threshold as { readonly unit: string },
      }),
    ).rejects.toThrow(ValidationError);
    expect(h.state()).toBe(before);
  });

  it("rejects a negative or fractional expectedVersion", async () => {
    const { h, mine, rice } = await setup();
    for (const expectedVersion of [-1, 0.5]) {
      await expect(
        h.setLowStockThreshold.execute(mine.OWNER, {
          variantId: rice.variant.id,
          expectedVersion,
          threshold: { quantityMinor: "1", unit: "KG" },
        }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it("needs an ACTIVE product that tracks inventory, and hides other businesses' products", async () => {
    const { h, mine, theirs, rice } = await setup();
    const untracked = await h.product(mine.OWNER, { trackInventory: false });
    const foreign = await h.product(theirs.OWNER);
    await h.catalog.archiveProduct.execute(mine.OWNER, { productId: rice.product.id, expectedVersion: 1 });
    const before = h.state();
    for (const variantId of [rice.variant.id, untracked.variant.id]) {
      await expect(
        h.setLowStockThreshold.execute(mine.OWNER, {
          variantId,
          expectedVersion: 0,
          threshold: { quantityMinor: "1", unit: variantId === rice.variant.id ? "KG" : "PIECE" },
        }),
      ).rejects.toThrow(ConflictError);
    }
    for (const variantId of [foreign.variant.id, "nope"]) {
      await expect(
        h.setLowStockThreshold.execute(mine.OWNER, {
          variantId,
          expectedVersion: 0,
          threshold: { quantityMinor: "1", unit: "PIECE" },
        }),
      ).rejects.toThrow(NotFoundError);
    }
    expect(h.state()).toBe(before);
  });

  it("is allowed to OWNER, MANAGER and STOCK_KEEPER; CASHIER and ACCOUNTANT are denied", async () => {
    const { h, mine, rice } = await setup();
    const before = h.state();
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      await expect(
        h.setLowStockThreshold.execute(mine[role], {
          variantId: rice.variant.id,
          expectedVersion: 0,
          threshold: { quantityMinor: "1", unit: "KG" },
        }),
      ).rejects.toThrow(PermissionDeniedError);
    }
    expect(h.state()).toBe(before);
    let version = 0;
    for (const [index, role] of (["OWNER", "MANAGER", "STOCK_KEEPER"] as const).entries()) {
      const result = await h.setLowStockThreshold.execute(mine[role], {
        variantId: rice.variant.id,
        expectedVersion: version,
        threshold: { quantityMinor: String(index + 1), unit: "KG" },
      });
      version = result.version;
    }
    expect(version).toBe(3);
  });
});

describe("ClearLowStockThreshold", () => {
  it("clears a configured threshold, keeps the row, bumps the version and audits the old value", async () => {
    const { h, mine, rice } = await setup();
    await h.setLowStockThreshold.execute(mine.OWNER, {
      variantId: rice.variant.id,
      expectedVersion: 0,
      threshold: { quantityMinor: "750", unit: "KG" },
    });
    const result = await h.clearLowStockThreshold.execute(mine.STOCK_KEEPER, {
      variantId: rice.variant.id,
      expectedVersion: 1,
    });
    expect(result).toMatchObject({ changed: true, version: 2 });
    expect(result).not.toHaveProperty("threshold");
    expect(h.inventory.thresholds).toHaveLength(1);
    expect(h.inventoryAudit().at(-1)).toMatchObject({
      action: "inventory.low_stock_threshold_cleared",
      payload: { variantId: rice.variant.id, stockUnit: "KG", fromThresholdMinor: "750" },
    });
    const reset = await h.setLowStockThreshold.execute(mine.OWNER, {
      variantId: rice.variant.id,
      expectedVersion: 2,
      threshold: { quantityMinor: "100", unit: "KG" },
    });
    expect(reset.version).toBe(3);
    expect(h.inventoryAudit().at(-1)?.payload).not.toHaveProperty("fromThresholdMinor");
  });

  it("is a no-op for an absent threshold at version 0 and for one already cleared", async () => {
    const { h, mine, rice } = await setup();
    const before = h.state();
    const absent = await h.clearLowStockThreshold.execute(mine.OWNER, {
      variantId: rice.variant.id,
      expectedVersion: 0,
    });
    expect(absent).toEqual({
      variantId: rice.variant.id,
      locationId: mine.OWNER.locationId,
      version: 0,
      changed: false,
    });
    expect(h.state()).toBe(before);
    await h.setLowStockThreshold.execute(mine.OWNER, {
      variantId: rice.variant.id,
      expectedVersion: 0,
      threshold: { quantityMinor: "1", unit: "KG" },
    });
    await h.clearLowStockThreshold.execute(mine.OWNER, { variantId: rice.variant.id, expectedVersion: 1 });
    const cleared = h.state();
    const again = await h.clearLowStockThreshold.execute(mine.OWNER, {
      variantId: rice.variant.id,
      expectedVersion: 2,
    });
    expect(again).toMatchObject({ changed: false, version: 2 });
    expect(h.state()).toBe(cleared);
  });

  it("rejects a stale version with VERSION_CONFLICT", async () => {
    const { h, mine, rice } = await setup();
    await h.setLowStockThreshold.execute(mine.OWNER, {
      variantId: rice.variant.id,
      expectedVersion: 0,
      threshold: { quantityMinor: "1", unit: "KG" },
    });
    const before = h.state();
    await expect(
      h.clearLowStockThreshold.execute(mine.OWNER, { variantId: rice.variant.id, expectedVersion: 0 }),
    ).rejects.toThrow(VersionConflictError);
    expect(h.state()).toBe(before);
  });

  it("works on archived and untracked products, hides foreign ones and denies CASHIER", async () => {
    const { h, mine, theirs, rice } = await setup();
    await h.setLowStockThreshold.execute(mine.OWNER, {
      variantId: rice.variant.id,
      expectedVersion: 0,
      threshold: { quantityMinor: "1", unit: "KG" },
    });
    await h.catalog.archiveProduct.execute(mine.OWNER, { productId: rice.product.id, expectedVersion: 1 });
    expect(
      (await h.clearLowStockThreshold.execute(mine.OWNER, { variantId: rice.variant.id, expectedVersion: 1 })).changed,
    ).toBe(true);
    const untracked = await h.product(mine.OWNER, { trackInventory: false });
    expect(
      (await h.clearLowStockThreshold.execute(mine.OWNER, { variantId: untracked.variant.id, expectedVersion: 0 }))
        .changed,
    ).toBe(false);
    const before = h.state();
    await expect(
      h.clearLowStockThreshold.execute(theirs.OWNER, { variantId: rice.variant.id, expectedVersion: 2 }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      h.clearLowStockThreshold.execute(mine.CASHIER, { variantId: rice.variant.id, expectedVersion: 2 }),
    ).rejects.toThrow(PermissionDeniedError);
    expect(h.state()).toBe(before);
  });
});
