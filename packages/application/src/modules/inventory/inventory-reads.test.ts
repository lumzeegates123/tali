import { defineCurrency, restoreLocation } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../../errors/application-error.js";
import { createInventoryHarness } from "../../testing/inventory-harness.js";

async function setup() {
  const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2), defineCurrency("KES", 2)] });
  const mine = await h.businessWithRoles("Mine", "NGN");
  const theirs = await h.businessWithRoles("Theirs", "KES");
  const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
  const soap = (
    await h.catalog.createProduct.execute(mine.OWNER, {
      name: "Bar soap",
      sku: "SOAP-1",
      stockUnit: "PIECE",
      trackInventory: true,
      idempotencyKey: key(),
    })
  ).item;
  const oil = await h.product(mine.OWNER, { name: "Palm oil" });
  const fresh = await h.product(mine.OWNER, { name: "Fresh bread" });
  const untracked = await h.product(mine.OWNER, { name: "Delivery service", trackInventory: false });
  const archivedEmpty = await h.product(mine.OWNER, { name: "Old stock" });
  await h.catalog.archiveProduct.execute(mine.OWNER, { productId: archivedEmpty.product.id, expectedVersion: 1 });
  const opening = await h.recordOpeningStock.execute(mine.OWNER, {
    lines: [
      { variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" },
      { variantId: oil.variant.id, quantityMinor: "3", unit: "PIECE" },
    ],
    idempotencyKey: key(),
  });
  await h.catalog.archiveProduct.execute(mine.OWNER, { productId: oil.product.id, expectedVersion: 1 });
  return { h, mine, theirs, key, soap, oil, fresh, untracked, archivedEmpty, opening };
}

const ROLES = ["OWNER", "MANAGER", "STOCK_KEEPER", "CASHIER", "ACCOUNTANT"] as const;

describe("ListInventoryItems and GetInventoryItem", () => {
  it("lists tracked ACTIVE items (stocked or not) and ARCHIVED items with stock, to every role", async () => {
    const { h, mine, soap, oil, fresh } = await setup();
    const expected = [soap.variant.id, oil.variant.id, fresh.variant.id].sort();
    for (const role of ROLES) {
      const page = await h.listInventoryItems.execute(mine[role]);
      expect(page.items.map((item) => item.variantId)).toEqual(expected);
    }
    const page = await h.listInventoryItems.execute(mine.OWNER);
    const byId = new Map(page.items.map((item) => [item.variantId, item]));
    expect(byId.get(fresh.variant.id)).toMatchObject({ productStatus: "ACTIVE", balanceVersion: 0, lowStock: false });
    expect(byId.get(fresh.variant.id)?.onHand.toMinorUnitsString()).toBe("0");
    expect(byId.get(oil.variant.id)).toMatchObject({ productStatus: "ARCHIVED", balanceVersion: 1 });
    expect(byId.get(soap.variant.id)).toMatchObject({ name: "Bar soap", stockUnit: "PIECE", thresholdVersion: 0 });
    expect("threshold" in (byId.get(soap.variant.id) ?? {})).toBe(false);
  });

  it("hides untracked items, archived items with no stock and other businesses' items", async () => {
    const { h, mine, theirs, untracked, archivedEmpty, soap } = await setup();
    for (const variantId of [untracked.variant.id, archivedEmpty.variant.id, "nope"]) {
      await expect(h.getInventoryItem.execute(mine.OWNER, { variantId })).rejects.toThrow(NotFoundError);
    }
    await expect(h.getInventoryItem.execute(theirs.OWNER, { variantId: soap.variant.id })).rejects.toThrow(
      NotFoundError,
    );
    expect((await h.listInventoryItems.execute(theirs.OWNER)).items).toEqual([]);
  });

  it("reports the threshold row: none at version 0, configured, and cleared with its version kept", async () => {
    const { h, mine, soap } = await setup();
    const read = () => h.getInventoryItem.execute(mine.OWNER, { variantId: soap.variant.id });
    expect(await read()).toMatchObject({ thresholdVersion: 0, lowStock: false });
    await h.setLowStockThreshold.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedVersion: 0,
      threshold: { quantityMinor: "10", unit: "PIECE" },
    });
    const configured = await read();
    expect(configured).toMatchObject({ thresholdVersion: 1, lowStock: true });
    expect(configured.threshold?.toMinorUnitsString()).toBe("10");
    await h.clearLowStockThreshold.execute(mine.OWNER, { variantId: soap.variant.id, expectedVersion: 1 });
    const cleared = await read();
    expect(cleared).toMatchObject({ thresholdVersion: 2, lowStock: false });
    expect("threshold" in cleared).toBe(false);
  });

  it("filters low-stock items: every row returned derives low stock", async () => {
    const { h, mine, soap, fresh } = await setup();
    await h.setLowStockThreshold.execute(mine.OWNER, {
      variantId: soap.variant.id,
      expectedVersion: 0,
      threshold: { quantityMinor: "5", unit: "PIECE" },
    });
    await h.setLowStockThreshold.execute(mine.OWNER, {
      variantId: fresh.variant.id,
      expectedVersion: 0,
      threshold: { quantityMinor: "0", unit: "PIECE" },
    });
    const low = await h.listInventoryItems.execute(mine.CASHIER, { lowStockOnly: true });
    expect(low.items.map((item) => item.variantId)).toEqual([fresh.variant.id]);
    expect(low.items.every((item) => item.lowStock)).toBe(true);
    await expect(
      h.listInventoryItems.execute(mine.OWNER, { lowStockOnly: "yes" as unknown as boolean }),
    ).rejects.toThrow(ValidationError);
  });

  it("searches like the catalog: name contains, or exact SKU", async () => {
    const { h, mine, soap, oil } = await setup();
    const byName = await h.listInventoryItems.execute(mine.OWNER, { q: "OIL" });
    expect(byName.items.map((item) => item.variantId)).toEqual([oil.variant.id]);
    const bySku = await h.listInventoryItems.execute(mine.OWNER, { q: "soap-1" });
    expect(bySku.items.map((item) => item.variantId)).toEqual([soap.variant.id]);
    await expect(h.listInventoryItems.execute(mine.OWNER, { q: "x".repeat(121) })).rejects.toThrow(ValidationError);
  });

  it("pages by variant ID", async () => {
    const { h, mine } = await setup();
    const first = await h.listInventoryItems.execute(mine.OWNER, { limit: 2 });
    const rest = await h.listInventoryItems.execute(mine.OWNER, { limit: 2, after: first.nextCursor ?? "" });
    expect(first.items).toHaveLength(2);
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
  });
});

describe("ListItemMovements", () => {
  it("lists a stock item's movements newest first, exposing no actor, device or correlation", async () => {
    const { h, mine, key, soap } = await setup();
    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "5", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    await h.recordWriteOff.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "2", unit: "PIECE" }],
      reasonCode: "DAMAGED",
      idempotencyKey: key(),
    });
    for (const role of ROLES) {
      const page = await h.listItemMovements.execute(mine[role], { variantId: soap.variant.id });
      expect(page.items.map((m) => [m.type, m.balanceVersion])).toEqual([
        ["WRITE_OFF", 3],
        ["PURCHASE_RECEIPT", 2],
        ["OPENING", 1],
      ]);
    }
    const [latest] = (await h.listItemMovements.execute(mine.OWNER, { variantId: soap.variant.id })).items;
    expect(Object.keys(latest ?? {}).sort()).toEqual(
      [
        "balanceAfter",
        "balanceVersion",
        "businessDate",
        "delta",
        "movementId",
        "occurredAt",
        "reasonCode",
        "source",
        "sourceChannel",
        "type",
      ].sort(),
    );
  });

  it("pages newest first by movement cursor", async () => {
    const { h, mine, key, soap } = await setup();
    for (let index = 0; index < 3; index += 1) {
      await h.postGoodsReceipt.execute(mine.OWNER, {
        lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
        idempotencyKey: key(),
      });
    }
    const first = await h.listItemMovements.execute(mine.OWNER, { variantId: soap.variant.id, limit: 2 });
    const rest = await h.listItemMovements.execute(mine.OWNER, {
      variantId: soap.variant.id,
      limit: 2,
      after: first.nextCursor ?? "",
    });
    expect([...first.items, ...rest.items].map((m) => m.balanceVersion)).toEqual([4, 3, 2, 1]);
    expect(rest.nextCursor).toBeNull();
  });

  it("continues from a valid final cursor to a legitimate empty page", async () => {
    const { h, mine, soap } = await setup();
    const only = await h.listItemMovements.execute(mine.OWNER, { variantId: soap.variant.id, limit: 1 });
    expect(only.items.map((m) => m.balanceVersion)).toEqual([1]);
    expect(only.nextCursor).toBeNull();
    const last = only.items[0]?.movementId ?? "";
    const after = await h.listItemMovements.execute(mine.OWNER, { variantId: soap.variant.id, after: last });
    expect(after).toEqual({ items: [], nextCursor: null });
  });

  it("rejects a malformed cursor, or one not of this exact stock item, alike as VALIDATION_FAILED", async () => {
    const { h, mine, theirs, key, soap, oil, opening } = await setup();
    const movementOf = (variantId: string) => opening.movements.find((m) => m.variantId === variantId)?.id ?? "";

    const now = h.catalog.tenancy.clock.now();
    const location = restoreLocation({
      id: h.catalog.tenancy.ids.newId("Location"),
      businessId: mine.OWNER.businessId,
      name: "Back store",
      isDefault: false,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    h.catalog.tenancy.store.putLocation(location);
    const back = { ...mine.OWNER, locationId: location.id };
    const backReceipt = await h.postGoodsReceipt.execute(back, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
      idempotencyKey: key(),
    });

    const foreignProduct = await h.product(theirs.OWNER, { name: "Their soap" });
    const foreignOpening = await h.recordOpeningStock.execute(theirs.OWNER, {
      lines: [{ variantId: foreignProduct.variant.id, quantityMinor: "1", unit: "PIECE" }],
      idempotencyKey: key(),
    });

    const malformed = await h.listItemMovements
      .execute(mine.OWNER, { variantId: soap.variant.id, after: "not-a-cursor" })
      .catch((error: unknown) => error);
    expect(malformed).toBeInstanceOf(ValidationError);
    if (!(malformed instanceof ValidationError)) throw new Error("expected a validation error");
    expect(malformed.code).toBe("VALIDATION_FAILED");

    const cursors = {
      unknown: h.catalog.tenancy.ids.newId("InventoryMovement"),
      otherVariant: movementOf(oil.variant.id),
      otherLocation: backReceipt.movements[0]?.id ?? "",
      otherBusiness: foreignOpening.movements[0]?.id ?? "",
    };
    for (const [name, after] of Object.entries(cursors)) {
      expect(after, name).not.toBe("");
      const error = await h.listItemMovements
        .execute(mine.OWNER, { variantId: soap.variant.id, after })
        .catch((caught: unknown) => caught);
      expect(error, name).toBeInstanceOf(ValidationError);
      if (!(error instanceof ValidationError)) throw new Error(`expected a validation error for ${name}`);
      expect([error.code, error.message, error.issues], name).toEqual([
        malformed.code,
        malformed.message,
        malformed.issues,
      ]);
    }

    const defaultCursor = movementOf(soap.variant.id);
    await expect(
      h.listItemMovements.execute(back, { variantId: soap.variant.id, after: defaultCursor }),
    ).rejects.toThrow(ValidationError);
    const backPage = await h.listItemMovements.execute(back, {
      variantId: soap.variant.id,
      after: cursors.otherLocation,
    });
    expect(backPage).toEqual({ items: [], nextCursor: null });
  });

  it("is NOT_FOUND for an invisible or foreign item, and shows only the context's location", async () => {
    const { h, mine, theirs, untracked, soap } = await setup();
    await expect(h.listItemMovements.execute(mine.OWNER, { variantId: untracked.variant.id })).rejects.toThrow(
      NotFoundError,
    );
    await expect(h.listItemMovements.execute(theirs.OWNER, { variantId: soap.variant.id })).rejects.toThrow(
      NotFoundError,
    );
    const now = h.catalog.tenancy.clock.now();
    const location = restoreLocation({
      id: h.catalog.tenancy.ids.newId("Location"),
      businessId: mine.OWNER.businessId,
      name: "Back store",
      isDefault: false,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    h.catalog.tenancy.store.putLocation(location);
    const back = await h.listItemMovements.execute(
      { ...mine.OWNER, locationId: location.id },
      { variantId: soap.variant.id },
    );
    expect(back.items).toEqual([]);
  });
});

describe("inventory document reads", () => {
  it("returns an opening batch header with its movements and no actor, device or correlation", async () => {
    const { h, mine, opening } = await setup();
    const result = await h.getOpeningBatch.execute(mine.ACCOUNTANT, { documentId: opening.document.id });
    expect(result.document).toMatchObject({ id: opening.document.id, locationId: mine.OWNER.locationId });
    for (const field of ["actorMembershipId", "deviceId", "correlationId", "businessId"]) {
      expect(field in result.document).toBe(false);
    }
    expect(result.movements.map((m) => m.variantId)).toEqual(opening.movements.map((m) => m.variantId));
    expect(result.movements.every((m) => !("actorMembershipId" in m) && !("correlationId" in m))).toBe(true);
  });

  it("returns a reversed goods receipt with its originals first, then the reversals", async () => {
    const { h, mine, key, soap, fresh } = await setup();
    const receipt = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [
        { variantId: soap.variant.id, quantityMinor: "5", unit: "PIECE" },
        { variantId: fresh.variant.id, quantityMinor: "2", unit: "PIECE" },
      ],
      reference: "INV-1",
      idempotencyKey: key(),
    });
    await h.reverseGoodsReceipt.execute(mine.OWNER, { documentId: receipt.document.id, reason: "Wrong supplier" });
    const result = await h.getGoodsReceipt.execute(mine.CASHIER, { documentId: receipt.document.id });
    expect(result.document).toMatchObject({ status: "REVERSED", reference: "INV-1", reversalReason: "Wrong supplier" });
    expect(result.movements.map((m) => m.reversesMovementId === undefined)).toEqual([true, true, false, false]);
  });

  it("returns an adjustment with its reason", async () => {
    const { h, mine, key, soap } = await setup();
    const adjustment = await h.recordAdjustment.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE", direction: "INCREASE" }],
      reasonCode: "FOUND_STOCK",
      idempotencyKey: key(),
    });
    const result = await h.getAdjustment.execute(mine.OWNER, { documentId: adjustment.document.id });
    expect(result.document).toMatchObject({ kind: "ADJUSTMENT", reasonCode: "FOUND_STOCK", status: "POSTED" });
    expect(result.movements).toHaveLength(1);
  });

  it("is NOT_FOUND for a malformed, foreign or other-location document", async () => {
    const { h, mine, theirs, opening } = await setup();
    const now = h.catalog.tenancy.clock.now();
    const location = restoreLocation({
      id: h.catalog.tenancy.ids.newId("Location"),
      businessId: mine.OWNER.businessId,
      name: "Back store",
      isDefault: false,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    h.catalog.tenancy.store.putLocation(location);
    for (const context of [theirs.OWNER, { ...mine.OWNER, locationId: location.id }]) {
      await expect(h.getOpeningBatch.execute(context, { documentId: opening.document.id })).rejects.toThrow(
        NotFoundError,
      );
    }
    for (const read of [h.getOpeningBatch, h.getGoodsReceipt, h.getAdjustment]) {
      await expect(read.execute(mine.OWNER, { documentId: "nope" })).rejects.toThrow(NotFoundError);
    }
    await expect(h.getGoodsReceipt.execute(mine.OWNER, { documentId: opening.document.id })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("requires inventory:read", async () => {
    const { h, mine, opening } = await setup();
    const outsider = { ...mine.OWNER, permissions: new Set<never>() };
    await expect(h.getOpeningBatch.execute(outsider, { documentId: opening.document.id })).rejects.toThrow(
      PermissionDeniedError,
    );
    await expect(h.listInventoryItems.execute(outsider)).rejects.toThrow(PermissionDeniedError);
  });
});
