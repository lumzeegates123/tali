import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  InsufficientStockError,
  PermissionDeniedError,
  ValidationError,
} from "../../errors/application-error.js";
import { createInventoryHarness } from "../../testing/inventory-harness.js";
import type { RecordAdjustmentInput } from "./adjustments.js";

async function setup() {
  const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2)] });
  const mine = await h.businessWithRoles("Mine", "NGN");
  const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
  const soap = await h.product(mine.OWNER, { name: "Soap" });
  const oil = await h.product(mine.OWNER, { name: "Oil" });
  await h.recordOpeningStock.execute(mine.OWNER, {
    lines: [
      { variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" },
      { variantId: oil.variant.id, quantityMinor: "5", unit: "PIECE" },
    ],
    idempotencyKey: key(),
  });
  return { h, mine, key, soap, oil };
}

describe("RecordAdjustment", () => {
  it("applies signed lines from an explicit direction and a positive magnitude", async () => {
    const { h, mine, key, soap, oil } = await setup();
    const outcome = await h.recordAdjustment.execute(mine.MANAGER, {
      lines: [
        { variantId: soap.variant.id, quantityMinor: "3", unit: "PIECE", direction: "DECREASE" },
        { variantId: oil.variant.id, quantityMinor: "2", unit: "PIECE", direction: "INCREASE" },
      ],
      reasonCode: "DATA_ENTRY_CORRECTION",
      idempotencyKey: key(),
    });
    expect(outcome.document).toMatchObject({ kind: "ADJUSTMENT", reasonCode: "DATA_ENTRY_CORRECTION" });
    const deltas = Object.fromEntries(outcome.movements.map((m) => [m.variantId, m.delta.toMinorUnitsString()]));
    expect(deltas).toEqual({ [soap.variant.id]: "-3", [oil.variant.id]: "2" });
    expect(outcome.movements.every((m) => m.type === "ADJUSTMENT" && m.reasonCode === "DATA_ENTRY_CORRECTION")).toBe(
      true,
    );
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("7");
    expect(h.stock(mine.OWNER, oil.variant.id)).toBe("7");
    expect(h.inventoryAudit().at(-1)).toMatchObject({
      action: "inventory.adjusted",
      entityType: "inventory_adjustment",
      reason: "DATA_ENTRY_CORRECTION",
      payload: { reasonCode: "DATA_ENTRY_CORRECTION", lineCount: 2 },
    });
    h.inventory.assertConsistent();
  });

  it("requires a note for OTHER and audits the note as the reason", async () => {
    const { h, mine, key, soap } = await setup();
    const line = { variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE", direction: "INCREASE" } as const;
    const before = h.state();
    await expect(
      h.recordAdjustment.execute(mine.OWNER, { lines: [line], reasonCode: "OTHER", idempotencyKey: key() }),
    ).rejects.toThrow(ValidationError);
    expect(h.state()).toBe(before);
    const outcome = await h.recordAdjustment.execute(mine.OWNER, {
      lines: [line],
      reasonCode: "OTHER",
      reasonNote: "Supplier sent one extra",
      idempotencyKey: key(),
    });
    expect(outcome.document.reasonNote).toBe("Supplier sent one extra");
    expect(h.inventoryAudit().at(-1)).toMatchObject({ reason: "Supplier sent one extra" });
  });

  it.each([
    ["a write-off reason code", { reasonCode: "DAMAGED" }],
    ["an unknown reason code", { reasonCode: "SHRUG" }],
    ["a missing direction", { direction: undefined }],
    ["an unknown direction", { direction: "SIDEWAYS" }],
  ])("rejects %s", async (_label, change) => {
    const { h, mine, key, soap } = await setup();
    const input = {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE", direction: "INCREASE" }],
      reasonCode: "FOUND_STOCK",
      idempotencyKey: key(),
    };
    const changed = ("reasonCode" in change
      ? { ...input, ...change }
      : { ...input, lines: [{ ...input.lines[0], ...change }] }) as unknown as RecordAdjustmentInput;
    const before = h.state();
    await expect(h.recordAdjustment.execute(mine.OWNER, changed)).rejects.toThrow(ValidationError);
    expect(h.state()).toBe(before);
  });

  it("refuses to go below zero with INSUFFICIENT_STOCK and writes nothing; exactly zero is allowed", async () => {
    const { h, mine, key, soap } = await setup();
    const decrease = (quantityMinor: string) =>
      h.recordAdjustment.execute(mine.OWNER, {
        lines: [{ variantId: soap.variant.id, quantityMinor, unit: "PIECE", direction: "DECREASE" }],
        reasonCode: "DATA_ENTRY_CORRECTION",
        idempotencyKey: key(),
      });
    const before = h.state();
    await expect(decrease("11")).rejects.toThrow(InsufficientStockError);
    expect(h.state()).toBe(before);
    await decrease("10");
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("0");
  });

  it("allows archived products so residual stock can be cleared; untracked products are a CONFLICT", async () => {
    const { h, mine, key, soap } = await setup();
    await h.catalog.archiveProduct.execute(mine.OWNER, { productId: soap.product.id, expectedVersion: 1 });
    await h.recordAdjustment.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE", direction: "DECREASE" }],
      reasonCode: "DATA_ENTRY_CORRECTION",
      idempotencyKey: key(),
    });
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("0");
    const untracked = await h.product(mine.OWNER, { trackInventory: false });
    await expect(
      h.recordAdjustment.execute(mine.OWNER, {
        lines: [{ variantId: untracked.variant.id, quantityMinor: "1", unit: "PIECE", direction: "INCREASE" }],
        reasonCode: "FOUND_STOCK",
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("is allowed to OWNER and MANAGER only", async () => {
    const { h, mine, key, soap } = await setup();
    const before = h.state();
    for (const role of ["STOCK_KEEPER", "CASHIER", "ACCOUNTANT"] as const) {
      await expect(
        h.recordAdjustment.execute(mine[role], {
          lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE", direction: "INCREASE" }],
          reasonCode: "FOUND_STOCK",
          idempotencyKey: key(),
        }),
      ).rejects.toThrow(PermissionDeniedError);
    }
    expect(h.state()).toBe(before);
  });
});

describe("RecordWriteOff", () => {
  it("records every line as a decrease with a WRITE_OFF reason and audits the code as the reason", async () => {
    const { h, mine, key, soap, oil } = await setup();
    const outcome = await h.recordWriteOff.execute(mine.OWNER, {
      lines: [
        { variantId: soap.variant.id, quantityMinor: "2", unit: "PIECE" },
        { variantId: oil.variant.id, decimal: "1", unit: "PIECE" },
      ],
      reasonCode: "EXPIRED",
      idempotencyKey: key(),
    });
    expect(outcome.document).toMatchObject({ kind: "WRITE_OFF", reasonCode: "EXPIRED" });
    expect(outcome.movements.every((m) => m.type === "WRITE_OFF" && m.delta.isNegative())).toBe(true);
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("8");
    expect(h.stock(mine.OWNER, oil.variant.id)).toBe("4");
    expect(h.inventoryAudit().at(-1)).toMatchObject({
      action: "inventory.written_off",
      reason: "EXPIRED",
      payload: { reasonCode: "EXPIRED", lineCount: 2 },
    });
  });

  it("rejects adjustment reason codes and directions, and refuses to go below zero", async () => {
    const { h, mine, key, soap } = await setup();
    const before = h.state();
    await expect(
      h.recordWriteOff.execute(mine.OWNER, {
        lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
        reasonCode: "FOUND_STOCK" as "DAMAGED",
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      h.recordWriteOff.execute(mine.OWNER, {
        lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE", direction: "DECREASE" } as never],
        reasonCode: "DAMAGED",
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      h.recordWriteOff.execute(mine.OWNER, {
        lines: [{ variantId: soap.variant.id, quantityMinor: "11", unit: "PIECE" }],
        reasonCode: "DAMAGED",
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(InsufficientStockError);
    expect(h.state()).toBe(before);
  });

  it("is allowed to OWNER and MANAGER only", async () => {
    const { h, mine, key, soap } = await setup();
    await h.recordWriteOff.execute(mine.MANAGER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
      reasonCode: "DAMAGED",
      idempotencyKey: key(),
    });
    const before = h.state();
    for (const role of ["STOCK_KEEPER", "CASHIER", "ACCOUNTANT"] as const) {
      await expect(
        h.recordWriteOff.execute(mine[role], {
          lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
          reasonCode: "DAMAGED",
          idempotencyKey: key(),
        }),
      ).rejects.toThrow(PermissionDeniedError);
    }
    expect(h.state()).toBe(before);
  });
});
