import { defineCurrency, MAX_INVENTORY_DOCUMENT_LINES, restoreLocation } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { parseCorrelationId } from "../../context/business-context.js";
import {
  ConflictError,
  IdempotencyKeyReusedError,
  InsufficientStockError,
  ValidationError,
} from "../../errors/application-error.js";
import { createInventoryHarness } from "../../testing/inventory-harness.js";

async function setup() {
  const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2)] });
  const mine = await h.businessWithRoles("Mine", "NGN");
  const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
  const soap = await h.product(mine.OWNER, { name: "Soap" });
  const rice = await h.product(mine.OWNER, { name: "Rice", stockUnit: "KG" });
  const oil = await h.product(mine.OWNER, { name: "Oil" });
  return { h, mine, key, soap, rice, oil };
}

describe("keyed inventory documents: plan and apply (plan decision D21)", () => {
  it("touches no repository between the idempotency lookup and the claim; all state work happens in apply()", async () => {
    const { h, mine, key, soap, rice } = await setup();
    const { pack } = await h.catalog.addPack.execute(mine.OWNER, {
      productId: soap.product.id,
      name: "Carton",
      factorMinor: "12",
      idempotencyKey: key(),
    });
    h.calls.length = 0;
    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [
        { variantId: soap.variant.id, packId: pack.id, packCount: "2" },
        { variantId: rice.variant.id, decimal: "1.5", unit: "KG" },
      ],
      idempotencyKey: key(),
    });
    expect(h.calls).toEqual([
      "memberships.findByBusinessAndUser",
      "units.findByCode",
      "idempotency.find",
      "idempotency.insert",
      "products.lockVariantsForShare",
      "packs.findForEntry",
      "balances.lockForUpdate",
      "goodsReceipts.insert",
      "movements.insertMany",
      "balances.apply",
      "audit.recordBusinessEvent",
      "movements.listOriginals",
    ]);
  });

  it("on replay reads only the stored result and the original movements", async () => {
    const { h, mine, key, soap } = await setup();
    const input = {
      lines: [{ variantId: soap.variant.id, quantityMinor: "3", unit: "PIECE" }],
      idempotencyKey: key(),
    };
    await h.recordOpeningStock.execute(mine.OWNER, input);
    h.calls.length = 0;
    await h.recordOpeningStock.execute(mine.OWNER, input);
    expect(h.calls).toEqual(["memberships.findByBusinessAndUser", "idempotency.find", "movements.listOriginals"]);
  });

  it("rolls back the claimed key with a rejection in apply(); a retry once the state is fixed runs fresh", async () => {
    const { h, mine, key, soap } = await setup();
    const input = {
      lines: [{ variantId: soap.variant.id, quantityMinor: "2", unit: "PIECE" }],
      reasonCode: "DAMAGED" as const,
      idempotencyKey: key(),
    };
    const keys = h.catalog.tenancy.businessIdempotencyStore.records.length;
    await expect(h.recordWriteOff.execute(mine.OWNER, input)).rejects.toThrow(InsufficientStockError);
    expect(h.calls).toContain("idempotency.insert");
    expect(h.catalog.tenancy.businessIdempotencyStore.records).toHaveLength(keys);
    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "5", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    const retried = await h.recordWriteOff.execute(mine.OWNER, input);
    expect(retried.replayed).toBe(false);
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("3");
  });

  it("rolls back the key when the product is archived; reactivating it lets the same key run fresh", async () => {
    const { h, mine, key, soap } = await setup();
    await h.catalog.archiveProduct.execute(mine.OWNER, { productId: soap.product.id, expectedVersion: 1 });
    const input = {
      lines: [{ variantId: soap.variant.id, quantityMinor: "2", unit: "PIECE" }],
      idempotencyKey: key(),
    };
    const before = h.state();
    await expect(h.postGoodsReceipt.execute(mine.OWNER, input)).rejects.toThrow(ConflictError);
    expect(h.state()).toBe(before);
    await h.catalog.reactivateProduct.execute(mine.OWNER, { productId: soap.product.id, expectedVersion: 2 });
    expect((await h.postGoodsReceipt.execute(mine.OWNER, input)).replayed).toBe(false);
  });
});

describe("keyed inventory documents: the fingerprint (plan section L)", () => {
  it("replays across correlation ID, device, channel and time, which are not part of the command", async () => {
    const { h, mine, key, soap } = await setup();
    const input = {
      lines: [{ variantId: soap.variant.id, quantityMinor: "3", unit: "PIECE" }],
      note: "First delivery",
      idempotencyKey: key(),
    };
    const first = await h.postGoodsReceipt.execute(mine.OWNER, input);
    h.catalog.tenancy.clock.advanceBySeconds(3600);
    const elsewhere = {
      ...mine.OWNER,
      correlationId: parseCorrelationId("retry-request"),
      deviceId: h.catalog.tenancy.ids.newId("Device"),
      sourceChannel: "mobile" as const,
    };
    const before = h.state();
    expect(await h.postGoodsReceipt.execute(elsewhere, input)).toEqual({ ...first, replayed: true });
    expect(h.state()).toBe(before);
  });

  it("treats line order and decimal or minor-unit spelling of the same quantity as the same command", async () => {
    const { h, mine, key, soap, rice } = await setup();
    const idempotencyKey = key();
    const first = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [
        { variantId: soap.variant.id, quantityMinor: "3", unit: "PIECE" },
        { variantId: rice.variant.id, quantityMinor: "1500", unit: "KG" },
      ],
      idempotencyKey,
    });
    const replay = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [
        { variantId: rice.variant.id, decimal: "1.500", unit: "KG" },
        { variantId: soap.variant.id, decimal: "3", unit: "PIECE" },
      ],
      idempotencyKey,
    });
    expect(replay).toEqual({ ...first, replayed: true });
  });

  it("rejects the key with KEY_REUSED for another location, quantity, note or pack count", async () => {
    const { h, mine, key, soap } = await setup();
    const { pack } = await h.catalog.addPack.execute(mine.OWNER, {
      productId: soap.product.id,
      name: "Carton",
      factorMinor: "12",
      idempotencyKey: key(),
    });
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
    const idempotencyKey = key();
    const input = { lines: [{ variantId: soap.variant.id, packId: pack.id, packCount: "2" }], idempotencyKey };
    await h.postGoodsReceipt.execute(mine.OWNER, input);
    const before = h.state();
    for (const [context, changed] of [
      [{ ...mine.OWNER, locationId: backStore.id }, input],
      [mine.OWNER, { ...input, lines: [{ variantId: soap.variant.id, packId: pack.id, packCount: "3" }] }],
      [mine.OWNER, { ...input, lines: [{ variantId: soap.variant.id, quantityMinor: "24", unit: "PIECE" }] }],
      [mine.OWNER, { ...input, note: "Second thoughts" }],
    ] as const) {
      await expect(h.postGoodsReceipt.execute(context, changed)).rejects.toThrow(IdempotencyKeyReusedError);
    }
    expect(h.state()).toBe(before);
  });

  it("keeps operations apart: an adjustment key cannot replay as a write-off", async () => {
    const { h, mine, key, soap } = await setup();
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "5", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    const idempotencyKey = key();
    await h.recordAdjustment.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE", direction: "DECREASE" }],
      reasonCode: "OTHER",
      reasonNote: "Broken",
      idempotencyKey,
    });
    await expect(
      h.recordWriteOff.execute(mine.OWNER, {
        lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
        reasonCode: "OTHER",
        reasonNote: "Broken",
        idempotencyKey,
      }),
    ).rejects.toThrow(IdempotencyKeyReusedError);
  });
});

describe("keyed inventory documents: atomicity after the claim", () => {
  const steps = [
    ["the idempotency claim", "idempotency", "businessIdempotency.insert"],
    ["the variant locks", "catalog", "products.lockVariantsForShare"],
    ["the balance locks", "inventory", "balances.lockForUpdate"],
    ["the document header", "inventory", "goodsReceipts.insert"],
    ["the movements", "inventory", "movements.insertMany"],
    ["the balances", "inventory", "balances.apply"],
    ["the audit record", "audit", "audit.inventory.received"],
  ] as const;

  it.each(steps)("leaves nothing behind when %s fails, and the same key then runs fresh", async (_label, store, op) => {
    const { h, mine, key, soap, oil } = await setup();
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "4", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    const input = {
      lines: [
        { variantId: soap.variant.id, quantityMinor: "6", unit: "PIECE" },
        { variantId: oil.variant.id, quantityMinor: "2", unit: "PIECE" },
      ],
      idempotencyKey: key(),
    };
    const failures = {
      idempotency: h.catalog.tenancy.businessIdempotencyStore.failures,
      catalog: h.catalog.catalog.failures,
      inventory: h.inventory.failures,
      audit: h.catalog.tenancy.auditWriter.failures,
    }[store];
    failures.failNext(op);
    const before = h.state();
    await expect(h.postGoodsReceipt.execute(mine.OWNER, input)).rejects.toThrow(/injected failure/);
    expect(h.state()).toBe(before);
    h.inventory.assertConsistent();
    const retried = await h.postGoodsReceipt.execute(mine.OWNER, input);
    expect(retried.replayed).toBe(false);
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("10");
    h.inventory.assertConsistent();
  });

  it.each([
    ["the header update", "goodsReceipts.markReversed"],
    ["the reversal movements", "movements.insertMany"],
    ["the balances", "balances.apply"],
  ] as const)("leaves a receipt POSTED when %s of its reversal fails", async (_label, op) => {
    const { h, mine, key, soap } = await setup();
    const receipt = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "6", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    h.inventory.failures.failNext(op);
    const before = h.state();
    await expect(
      h.reverseGoodsReceipt.execute(mine.OWNER, { documentId: receipt.document.id, reason: "Wrong" }),
    ).rejects.toThrow(/injected failure/);
    expect(h.state()).toBe(before);
    h.inventory.assertConsistent();
  });

  it("leaves a receipt POSTED when the reversal audit fails, and a threshold unset when its audit fails", async () => {
    const { h, mine, key, soap } = await setup();
    const receipt = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "6", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    const before = h.state();
    h.catalog.tenancy.auditWriter.failures.failNext("audit.inventory.receipt_reversed");
    await expect(
      h.reverseGoodsReceipt.execute(mine.OWNER, { documentId: receipt.document.id, reason: "Wrong" }),
    ).rejects.toThrow(/injected failure/);
    h.catalog.tenancy.auditWriter.failures.failNext("audit.inventory.low_stock_threshold_set");
    await expect(
      h.setLowStockThreshold.execute(mine.OWNER, {
        variantId: soap.variant.id,
        expectedVersion: 0,
        threshold: { quantityMinor: "2", unit: "PIECE" },
      }),
    ).rejects.toThrow(/injected failure/);
    expect(h.state()).toBe(before);
  });
});

describe("keyed inventory documents: replay and line limits", () => {
  it("returns movements in ascending variant order and replays them deep-equal, before and after a reversal", async () => {
    const { h, mine, key, soap, rice, oil } = await setup();
    const input = {
      lines: [
        { variantId: oil.variant.id, quantityMinor: "1", unit: "PIECE" },
        { variantId: soap.variant.id, quantityMinor: "2", unit: "PIECE" },
        { variantId: rice.variant.id, quantityMinor: "3000", unit: "KG" },
      ],
      reference: "DN-1",
      idempotencyKey: key(),
    };
    const first = await h.postGoodsReceipt.execute(mine.OWNER, input);
    const ids = first.movements.map((m) => m.variantId);
    expect(ids).toEqual([...ids].sort());
    expect(await h.postGoodsReceipt.execute(mine.OWNER, input)).toEqual({ ...first, replayed: true });
    await h.reverseGoodsReceipt.execute(mine.OWNER, { documentId: first.document.id, reason: "Wrong" });
    expect(await h.postGoodsReceipt.execute(mine.OWNER, input)).toEqual({ ...first, replayed: true });
  });

  it(`accepts ${MAX_INVENTORY_DOCUMENT_LINES} lines and rejects 0 and ${MAX_INVENTORY_DOCUMENT_LINES + 1}`, async () => {
    const { h, mine, key } = await setup();
    const products = [];
    for (let i = 0; i < MAX_INVENTORY_DOCUMENT_LINES; i += 1) products.push(await h.product(mine.OWNER));
    const lines = products.map((p) => ({ variantId: p.variant.id, quantityMinor: "1", unit: "PIECE" }));
    const input = { lines, idempotencyKey: key() };
    const outcome = await h.recordOpeningStock.execute(mine.OWNER, input);
    expect(outcome.movements).toHaveLength(MAX_INVENTORY_DOCUMENT_LINES);
    expect(outcome.document.lineCount).toBe(MAX_INVENTORY_DOCUMENT_LINES);
    expect(h.inventoryAudit().at(-1)?.payload).toEqual({ lineCount: MAX_INVENTORY_DOCUMENT_LINES });
    expect(await h.recordOpeningStock.execute(mine.OWNER, input)).toEqual({ ...outcome, replayed: true });
    const before = h.state();
    const extra = { variantId: h.catalog.tenancy.ids.newId("ProductVariant"), quantityMinor: "1", unit: "PIECE" };
    for (const tooMany of [[], [...lines, extra]]) {
      await expect(h.recordOpeningStock.execute(mine.OWNER, { lines: tooMany, idempotencyKey: key() })).rejects.toThrow(
        ValidationError,
      );
    }
    expect(h.state()).toBe(before);
  });
});
