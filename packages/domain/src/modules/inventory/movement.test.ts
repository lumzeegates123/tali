import { describe, expect, it } from "vitest";
import type { DomainErrorCode } from "../../errors.js";
import { DomainError } from "../../errors.js";
import type { KernelErrorCode } from "../../kernel/index.js";
import { BusinessDate, KernelError, parseTimeZoneId, parseUnitCode, Quantity } from "../../kernel/index.js";
import { parseBusinessId, parseMembershipId } from "../business/index.js";
import { parseProductPackId, parseProductVariantId } from "../catalog/index.js";
import { parseDeviceId } from "../device/index.js";
import { parseLocationId } from "../location/index.js";
import type { InventoryMovementSource, InventoryMovementType } from "./index.js";
import {
  createInventoryRecording,
  INVENTORY_MOVEMENT_TYPES,
  parseGoodsReceiptId,
  parseInventoryAdjustmentId,
  parseInventoryMovementId,
  parseOpeningBatchId,
  parsePackSnapshot,
  parseStocktakeId,
  restoreMovement,
  sourceKindFor,
} from "./index.js";

const uuid = (n: number): string => `01928c6e-8b3a-7c4d-9e5f-${n.toString(16).padStart(12, "0")}`;
const businessId = parseBusinessId(uuid(1));
const locationId = parseLocationId(uuid(2));
const variantId = parseProductVariantId(uuid(3));
const actorMembershipId = parseMembershipId(uuid(4));
const movementId = parseInventoryMovementId(uuid(10));
const originalId = parseInventoryMovementId(uuid(11));
const packId = parseProductPackId(uuid(12));
const PIECE = parseUnitCode("PIECE");
const KG = parseUnitCode("KG");
const now = new Date("2026-10-08T23:30:00.000Z");
const recording = createInventoryRecording({
  actorMembershipId,
  sourceChannel: "web",
  correlationId: "req-1",
  now,
  timeZone: parseTimeZoneId("Africa/Lagos"),
});

const SOURCES: Readonly<Record<InventoryMovementType, InventoryMovementSource>> = {
  OPENING: { kind: "OPENING_BATCH", id: parseOpeningBatchId(uuid(20)) },
  PURCHASE_RECEIPT: { kind: "GOODS_RECEIPT", id: parseGoodsReceiptId(uuid(21)) },
  ADJUSTMENT: { kind: "ADJUSTMENT", id: parseInventoryAdjustmentId(uuid(22)) },
  WRITE_OFF: { kind: "ADJUSTMENT", id: parseInventoryAdjustmentId(uuid(22)) },
  COUNT_CORRECTION: { kind: "STOCKTAKE", id: parseStocktakeId(uuid(23)) },
};

const ORIGINAL_REASON: Readonly<Record<InventoryMovementType, { reasonCode?: string; reasonNote?: string }>> = {
  OPENING: {},
  PURCHASE_RECEIPT: {},
  ADJUSTMENT: { reasonCode: "FOUND_STOCK" },
  WRITE_OFF: { reasonCode: "DAMAGED" },
  COUNT_CORRECTION: {},
};

const pieces = (minor: bigint): Quantity => Quantity.ofMinor(minor, PIECE);

function movementProps(type: InventoryMovementType, deltaMinor: bigint, reversal = false) {
  return {
    id: movementId,
    businessId,
    locationId,
    variantId,
    type: type as string,
    delta: pieces(deltaMinor),
    balanceAfter: pieces(10n),
    balanceVersion: 2,
    source: SOURCES[type],
    ...(reversal ? { reversesMovementId: originalId, reasonNote: "Entered twice" } : ORIGINAL_REASON[type]),
    ...recording,
  };
}

function expectDomainError(action: () => unknown, code: DomainErrorCode, field?: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
  if (field !== undefined) expect((caught as DomainError).field).toBe(field);
}

function expectKernelError(action: () => unknown, code: KernelErrorCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(KernelError);
  expect((caught as KernelError).code).toBe(code);
}

describe("movement types", () => {
  it("implements the five Build 2 types; sales types do not exist yet", () => {
    expect(INVENTORY_MOVEMENT_TYPES).toEqual([
      "OPENING",
      "PURCHASE_RECEIPT",
      "ADJUSTMENT",
      "WRITE_OFF",
      "COUNT_CORRECTION",
    ]);
    for (const type of ["SALE", "CUSTOMER_RETURN", "SUPPLIER_RETURN", "opening"]) {
      expectDomainError(
        () => restoreMovement({ ...movementProps("PURCHASE_RECEIPT", 5n), type }),
        "INVALID_VALUE",
        "type",
      );
    }
  });

  it("maps each type to its typed source document", () => {
    expect(INVENTORY_MOVEMENT_TYPES.map((type) => sourceKindFor(type))).toEqual([
      "OPENING_BATCH",
      "GOODS_RECEIPT",
      "ADJUSTMENT",
      "ADJUSTMENT",
      "STOCKTAKE",
    ]);
    expectDomainError(
      () => restoreMovement({ ...movementProps("PURCHASE_RECEIPT", 5n), source: SOURCES.OPENING }),
      "INVALID_VALUE",
      "source",
    );
    expectDomainError(
      () => restoreMovement({ ...movementProps("OPENING", 5n), source: SOURCES.ADJUSTMENT }),
      "INVALID_VALUE",
      "source",
    );
    expectDomainError(
      () => restoreMovement({ ...movementProps("COUNT_CORRECTION", 5n), source: SOURCES.ADJUSTMENT }),
      "INVALID_VALUE",
      "source",
    );
  });
});

describe("movement direction", () => {
  it.each([
    ["OPENING", 5n],
    ["PURCHASE_RECEIPT", 5n],
    ["ADJUSTMENT", 5n],
    ["ADJUSTMENT", -5n],
    ["WRITE_OFF", -5n],
    ["COUNT_CORRECTION", 5n],
    ["COUNT_CORRECTION", -5n],
  ] as const)("accepts an original %s of %s", (type, delta) => {
    const movement = restoreMovement(movementProps(type, delta));
    expect(movement.delta.amountMinor).toBe(delta);
    expect(movement.reversesMovementId).toBeUndefined();
    expect(Object.isFrozen(movement)).toBe(true);
  });

  it.each([
    ["OPENING", -5n],
    ["PURCHASE_RECEIPT", -5n],
    ["WRITE_OFF", 5n],
  ] as const)("rejects an original %s of %s", (type, delta) => {
    expectDomainError(() => restoreMovement(movementProps(type, delta)), "INVALID_VALUE", "quantity");
  });

  it.each([
    ["PURCHASE_RECEIPT", -5n],
    ["WRITE_OFF", 5n],
    ["ADJUSTMENT", 5n],
    ["ADJUSTMENT", -5n],
  ] as const)("accepts a %s reversal of %s", (type, delta) => {
    const movement = restoreMovement(movementProps(type, delta, true));
    expect(movement.reversesMovementId).toBe(originalId);
    expect(movement.reasonCode).toBeUndefined();
    expect(movement.reasonNote).toBe("Entered twice");
  });

  it.each([
    ["PURCHASE_RECEIPT", 5n],
    ["WRITE_OFF", -5n],
  ] as const)("rejects a %s reversal of %s", (type, delta) => {
    expectDomainError(() => restoreMovement(movementProps(type, delta, true)), "INVALID_VALUE", "quantity");
  });

  it("never reverses OPENING", () => {
    expectDomainError(() => restoreMovement(movementProps("OPENING", -5n, true)), "INVALID_TRANSITION");
    expectDomainError(() => restoreMovement(movementProps("OPENING", 5n, true)), "INVALID_TRANSITION");
  });

  it("never reverses COUNT_CORRECTION", () => {
    expectDomainError(() => restoreMovement(movementProps("COUNT_CORRECTION", -5n, true)), "INVALID_TRANSITION");
    expectDomainError(() => restoreMovement(movementProps("COUNT_CORRECTION", 5n, true)), "INVALID_TRANSITION");
  });

  it.each(INVENTORY_MOVEMENT_TYPES)("rejects a zero %s delta", (type) => {
    expectDomainError(() => restoreMovement(movementProps(type, 0n)), "INVALID_VALUE", "quantity");
  });

  it("rejects a movement that reverses itself", () => {
    expectDomainError(
      () => restoreMovement({ ...movementProps("ADJUSTMENT", 5n, true), reversesMovementId: movementId }),
      "INVALID_VALUE",
      "reversesMovementId",
    );
  });
});

describe("movement balance fields", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects balanceVersion %s", (balanceVersion) => {
    expectDomainError(
      () => restoreMovement({ ...movementProps("PURCHASE_RECEIPT", 5n), balanceVersion }),
      "INVALID_VALUE",
      "balanceVersion",
    );
  });

  it("accepts balanceVersion 1 and a negative balanceAfter (no balance sign rule on a movement)", () => {
    const movement = restoreMovement({
      ...movementProps("ADJUSTMENT", -5n),
      balanceVersion: 1,
      balanceAfter: pieces(-5n),
    });
    expect(movement.balanceVersion).toBe(1);
    expect(movement.balanceAfter.amountMinor).toBe(-5n);
  });

  it("requires delta and balanceAfter in the same unit", () => {
    expectKernelError(
      () => restoreMovement({ ...movementProps("PURCHASE_RECEIPT", 5n), balanceAfter: Quantity.ofMinor(5n, KG) }),
      "UNIT_MISMATCH",
    );
  });

  it("keeps quantities within the kernel bounds", () => {
    const max = Quantity.ofMinor(1_000_000_000_000_000n, PIECE);
    const movement = restoreMovement({ ...movementProps("PURCHASE_RECEIPT", 5n), delta: max, balanceAfter: max });
    expect(movement.delta.amountMinor).toBe(1_000_000_000_000_000n);
    expectKernelError(() => max.add(pieces(1n)), "QUANTITY_OUT_OF_RANGE");
  });
});

describe("pack snapshots", () => {
  const pack = { packId, name: "Carton of 24", count: 3n, factorMinor: 24n };

  it("accepts an original packed movement whose quantity is exactly count x factor", () => {
    const movement = restoreMovement({ ...movementProps("PURCHASE_RECEIPT", 72n), pack });
    expect(movement.pack).toEqual({ packId, name: "Carton of 24", count: 3n, factorMinor: 24n });
    const writeOff = restoreMovement({ ...movementProps("WRITE_OFF", -72n), pack });
    expect(writeOff.pack?.count).toBe(3n);
  });

  it("rejects an off-by-one quantity", () => {
    expectDomainError(
      () => restoreMovement({ ...movementProps("PURCHASE_RECEIPT", 73n), pack }),
      "INVALID_VALUE",
      "pack",
    );
    expectDomainError(
      () => restoreMovement({ ...movementProps("PURCHASE_RECEIPT", 71n), pack }),
      "INVALID_VALUE",
      "pack",
    );
  });

  it("multiplies exactly with bigint at the bounds", () => {
    const factorMinor = 1_000_000_000n;
    const count = 1_000_000n;
    const movement = restoreMovement({
      ...movementProps("PURCHASE_RECEIPT", count * factorMinor),
      balanceAfter: pieces(count * factorMinor),
      pack: { packId, name: "Bale", count, factorMinor },
    });
    expect(movement.delta.amountMinor).toBe(1_000_000_000_000_000n);
  });

  it("never puts a pack snapshot on a COUNT_CORRECTION", () => {
    expectDomainError(
      () => restoreMovement({ ...movementProps("COUNT_CORRECTION", 72n), pack }),
      "INVALID_VALUE",
      "pack",
    );
  });

  it("never puts a pack snapshot on a reversal", () => {
    expectDomainError(
      () => restoreMovement({ ...movementProps("PURCHASE_RECEIPT", -72n, true), pack }),
      "INVALID_VALUE",
      "pack",
    );
  });

  it.each([0n, -1n])("rejects pack count %s", (count) => {
    expectDomainError(() => parsePackSnapshot({ ...pack, count }), "INVALID_VALUE", "packCount");
  });

  it("rejects a pack count above the quantity bound", () => {
    expectDomainError(
      () => parsePackSnapshot({ ...pack, count: 1_000_000_000_000_001n }),
      "INVALID_VALUE",
      "packCount",
    );
  });

  it.each([0n, 1n, 1_000_000_001n])(
    "rejects pack factor %s (accepted ProductPack bounds are 2..10^9)",
    (factorMinor) => {
      expectDomainError(() => parsePackSnapshot({ ...pack, factorMinor }), "INVALID_VALUE", "factorMinor");
    },
  );

  it("rejects a non-bigint count or factor", () => {
    expectDomainError(() => parsePackSnapshot({ ...pack, count: 3 as unknown as bigint }), "INVALID_VALUE");
    expectDomainError(() => parsePackSnapshot({ ...pack, factorMinor: 24 as unknown as bigint }), "INVALID_VALUE");
  });

  it("validates the pack name", () => {
    expectDomainError(() => parsePackSnapshot({ ...pack, name: "   " }), "INVALID_VALUE", "name");
    expect(parsePackSnapshot({ ...pack, name: "  Crate  " }).name).toBe("Crate");
  });
});

describe("movement reasons", () => {
  it("OPENING, PURCHASE_RECEIPT and COUNT_CORRECTION originals carry no reason", () => {
    for (const type of ["OPENING", "PURCHASE_RECEIPT", "COUNT_CORRECTION"] as const) {
      expectDomainError(
        () => restoreMovement({ ...movementProps(type, 5n), reasonCode: "OTHER", reasonNote: "x" }),
        "INVALID_VALUE",
        "reasonCode",
      );
      expectDomainError(
        () => restoreMovement({ ...movementProps(type, 5n), reasonNote: "x" }),
        "INVALID_VALUE",
        "reasonCode",
      );
    }
  });

  it("ADJUSTMENT and WRITE_OFF originals require a reason code from their own list", () => {
    expectDomainError(
      () => restoreMovement({ ...movementProps("ADJUSTMENT", 5n), reasonCode: undefined }),
      "INVALID_VALUE",
      "reasonCode",
    );
    expectDomainError(
      () => restoreMovement({ ...movementProps("ADJUSTMENT", 5n), reasonCode: "DAMAGED" }),
      "INVALID_VALUE",
      "reasonCode",
    );
    expectDomainError(
      () => restoreMovement({ ...movementProps("WRITE_OFF", -5n), reasonCode: "FOUND_STOCK" }),
      "INVALID_VALUE",
      "reasonCode",
    );
    expectDomainError(
      () => restoreMovement({ ...movementProps("WRITE_OFF", -5n), reasonCode: "OTHER" }),
      "INVALID_VALUE",
      "reasonNote",
    );
    const other = restoreMovement({ ...movementProps("WRITE_OFF", -5n), reasonCode: "OTHER", reasonNote: " Rats " });
    expect(other).toMatchObject({ reasonCode: "OTHER", reasonNote: "Rats" });
  });

  it("a reversal carries no reason code and requires its reason note", () => {
    expectDomainError(
      () => restoreMovement({ ...movementProps("ADJUSTMENT", 5n, true), reasonCode: "FOUND_STOCK" }),
      "INVALID_VALUE",
      "reasonCode",
    );
    expectDomainError(
      () => restoreMovement({ ...movementProps("ADJUSTMENT", 5n, true), reasonNote: undefined }),
      "INVALID_VALUE",
      "reasonNote",
    );
    expectDomainError(
      () => restoreMovement({ ...movementProps("ADJUSTMENT", 5n, true), reasonNote: "  " }),
      "INVALID_VALUE",
      "reasonNote",
    );
    expectDomainError(
      () => restoreMovement({ ...movementProps("ADJUSTMENT", 5n, true), reasonNote: "x".repeat(501) }),
      "INVALID_VALUE",
      "reasonNote",
    );
  });
});

describe("movement recording metadata", () => {
  it("derives the business date in the business time zone and copies instants", () => {
    const movement = restoreMovement(movementProps("PURCHASE_RECEIPT", 5n));
    expect(movement.businessDate.equals(BusinessDate.of(2026, 10, 9))).toBe(true);
    expect(movement.occurredAt).toEqual(now);
    expect(movement.occurredAt).not.toBe(recording.occurredAt);
    expect(movement).toMatchObject({ actorMembershipId, sourceChannel: "web", correlationId: "req-1" });
    expect(movement.deviceId).toBeUndefined();
  });

  it("keeps a device when one is recorded", () => {
    const deviceId = parseDeviceId(uuid(30));
    expect(restoreMovement({ ...movementProps("PURCHASE_RECEIPT", 5n), deviceId }).deviceId).toBe(deviceId);
  });

  it("rejects invalid instants, a record before it occurred, a missing business date and blank tokens", () => {
    const base = movementProps("PURCHASE_RECEIPT", 5n);
    expectDomainError(
      () => restoreMovement({ ...base, occurredAt: new Date(Number.NaN) }),
      "INVALID_VALUE",
      "occurredAt",
    );
    expectDomainError(
      () => restoreMovement({ ...base, recordedAt: new Date(now.getTime() - 1) }),
      "INVALID_VALUE",
      "recordedAt",
    );
    expectDomainError(
      () => restoreMovement({ ...base, businessDate: "2026-10-09" as unknown as BusinessDate }),
      "INVALID_VALUE",
      "businessDate",
    );
    expectDomainError(() => restoreMovement({ ...base, sourceChannel: "" }), "INVALID_VALUE", "sourceChannel");
    expectDomainError(() => restoreMovement({ ...base, correlationId: "" }), "INVALID_VALUE", "correlationId");
  });

  it("rejects non-quantity deltas", () => {
    expectDomainError(
      () => restoreMovement({ ...movementProps("PURCHASE_RECEIPT", 5n), delta: 5n as unknown as Quantity }),
      "INVALID_VALUE",
      "quantity",
    );
  });
});
