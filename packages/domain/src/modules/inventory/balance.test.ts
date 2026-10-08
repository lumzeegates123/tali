import { describe, expect, it } from "vitest";
import type { DomainErrorCode } from "../../errors.js";
import { DomainError } from "../../errors.js";
import { KernelError, parseTimeZoneId, parseUnitCode, Quantity } from "../../kernel/index.js";
import { parseBusinessId, parseMembershipId } from "../business/index.js";
import { parseProductVariantId } from "../catalog/index.js";
import { parseLocationId } from "../location/index.js";
import type { InventoryMovementType, StockBalance } from "./index.js";
import {
  applyMovementToBalance,
  createInventoryRecording,
  emptyStockBalance,
  parseGoodsReceiptId,
  parseInventoryAdjustmentId,
  parseInventoryMovementId,
  restoreMovement,
  restoreStockBalance,
} from "./index.js";

const uuid = (n: number): string => `01928c6e-8b3a-7c4d-9e5f-${n.toString(16).padStart(12, "0")}`;
const businessId = parseBusinessId(uuid(1));
const locationId = parseLocationId(uuid(2));
const variantId = parseProductVariantId(uuid(3));
const PIECE = parseUnitCode("PIECE");
const KG = parseUnitCode("KG");
const recording = createInventoryRecording({
  actorMembershipId: parseMembershipId(uuid(4)),
  sourceChannel: "web",
  correlationId: "req-1",
  now: new Date("2026-10-08T10:00:00.000Z"),
  timeZone: parseTimeZoneId("Africa/Lagos"),
});
const pieces = (minor: bigint): Quantity => Quantity.ofMinor(minor, PIECE);

function movement(props: {
  readonly n: number;
  readonly type: InventoryMovementType;
  readonly delta: Quantity;
  readonly balanceAfter: Quantity;
  readonly balanceVersion: number;
}) {
  const adjusting = props.type === "ADJUSTMENT" || props.type === "WRITE_OFF";
  return restoreMovement({
    id: parseInventoryMovementId(uuid(100 + props.n)),
    businessId,
    locationId,
    variantId,
    type: props.type,
    delta: props.delta,
    balanceAfter: props.balanceAfter,
    balanceVersion: props.balanceVersion,
    source: adjusting
      ? { kind: "ADJUSTMENT", id: parseInventoryAdjustmentId(uuid(21)) }
      : { kind: "GOODS_RECEIPT", id: parseGoodsReceiptId(uuid(20)) },
    ...(props.type === "ADJUSTMENT" ? { reasonCode: "FOUND_STOCK" } : {}),
    ...(props.type === "WRITE_OFF" ? { reasonCode: "DAMAGED" } : {}),
    ...recording,
  });
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

describe("StockBalance", () => {
  it("a missing row is version 0 with zero quantity in the stock unit and no last movement", () => {
    const empty = emptyStockBalance({ businessId, locationId, variantId, stockUnit: KG });
    expect(empty.version).toBe(0);
    expect(empty.quantity.equals(Quantity.zero(KG))).toBe(true);
    expect(empty.lastMovementId).toBeUndefined();
    expect(Object.isFrozen(empty)).toBe(true);
  });

  it("applies an exact positive delta, increments the version once and records the last movement", () => {
    const empty = emptyStockBalance({ businessId, locationId, variantId, stockUnit: PIECE });
    const receipt = movement({
      n: 1,
      type: "PURCHASE_RECEIPT",
      delta: pieces(12n),
      balanceAfter: pieces(12n),
      balanceVersion: 1,
    });
    const next = applyMovementToBalance(empty, receipt);
    expect(next).toMatchObject({ version: 1, lastMovementId: receipt.id });
    expect(next.quantity.amountMinor).toBe(12n);
    expect(empty.version).toBe(0);
  });

  it("applies an exact negative delta", () => {
    const current = restoreStockBalance({
      businessId,
      locationId,
      variantId,
      quantity: pieces(12n),
      version: 1,
      lastMovementId: parseInventoryMovementId(uuid(101)),
    });
    const writeOff = movement({
      n: 2,
      type: "WRITE_OFF",
      delta: pieces(-5n),
      balanceAfter: pieces(7n),
      balanceVersion: 2,
    });
    const next = applyMovementToBalance(current, writeOff);
    expect(next.quantity.amountMinor).toBe(7n);
    expect(next.version).toBe(2);
    expect(next.lastMovementId).toBe(writeOff.id);
  });

  it("imposes no non-negative invariant on the balance itself", () => {
    const negative = restoreStockBalance({
      businessId,
      locationId,
      variantId,
      quantity: pieces(-3n),
      version: 4,
      lastMovementId: parseInventoryMovementId(uuid(101)),
    });
    expect(negative.quantity.amountMinor).toBe(-3n);
    const adjustment = movement({
      n: 3,
      type: "ADJUSTMENT",
      delta: pieces(-1n),
      balanceAfter: pieces(-4n),
      balanceVersion: 5,
    });
    expect(applyMovementToBalance(negative, adjustment).quantity.amountMinor).toBe(-4n);
  });

  it("rejects a movement that does not follow the balance and version", () => {
    const empty = emptyStockBalance({ businessId, locationId, variantId, stockUnit: PIECE });
    const wrongVersion = movement({
      n: 4,
      type: "PURCHASE_RECEIPT",
      delta: pieces(5n),
      balanceAfter: pieces(5n),
      balanceVersion: 2,
    });
    expectDomainError(() => applyMovementToBalance(empty, wrongVersion), "INVALID_VALUE", "balanceVersion");
    const wrongAfter = movement({
      n: 5,
      type: "PURCHASE_RECEIPT",
      delta: pieces(5n),
      balanceAfter: pieces(6n),
      balanceVersion: 1,
    });
    expectDomainError(() => applyMovementToBalance(empty, wrongAfter), "INVALID_VALUE", "balanceVersion");
  });

  it("rejects a movement of another stock item", () => {
    const otherItem = emptyStockBalance({
      businessId,
      locationId,
      variantId: parseProductVariantId(uuid(9)),
      stockUnit: PIECE,
    });
    const receipt = movement({
      n: 6,
      type: "PURCHASE_RECEIPT",
      delta: pieces(5n),
      balanceAfter: pieces(5n),
      balanceVersion: 1,
    });
    expectDomainError(() => applyMovementToBalance(otherItem, receipt), "INVALID_VALUE", "movement");
  });

  it("rejects a movement in another unit", () => {
    const empty = emptyStockBalance({ businessId, locationId, variantId, stockUnit: KG });
    const receipt = movement({
      n: 7,
      type: "PURCHASE_RECEIPT",
      delta: pieces(5n),
      balanceAfter: pieces(5n),
      balanceVersion: 1,
    });
    expect(() => applyMovementToBalance(empty, receipt)).toThrow(KernelError);
  });

  it("stays within the quantity bounds", () => {
    const full = restoreStockBalance({
      businessId,
      locationId,
      variantId,
      quantity: pieces(1_000_000_000_000_000n),
      version: 1,
      lastMovementId: parseInventoryMovementId(uuid(101)),
    });
    expect(() => full.quantity.add(pieces(1n))).toThrow(KernelError);
  });

  it("validates stored balances", () => {
    const base = { businessId, locationId, variantId, quantity: pieces(0n), version: 0 };
    expect(restoreStockBalance(base).version).toBe(0);
    expectDomainError(
      () => restoreStockBalance({ ...base, lastMovementId: parseInventoryMovementId(uuid(101)) }),
      "INVALID_VALUE",
      "lastMovementId",
    );
    expectDomainError(() => restoreStockBalance({ ...base, version: 1 }), "INVALID_VALUE", "lastMovementId");
    expectDomainError(() => restoreStockBalance({ ...base, quantity: pieces(2n) }), "INVALID_VALUE", "quantity");
    for (const version of [-1, 1.5, Number.NaN]) {
      expectDomainError(() => restoreStockBalance({ ...base, version }), "INVALID_VALUE", "version");
    }
    expectDomainError(
      () => restoreStockBalance({ ...base, quantity: 0n as unknown as Quantity }),
      "INVALID_VALUE",
      "quantity",
    );
    const zeroAfterMovements: StockBalance = restoreStockBalance({
      ...base,
      version: 3,
      lastMovementId: parseInventoryMovementId(uuid(101)),
    });
    expect(zeroAfterMovements.version).toBe(3);
  });
});
