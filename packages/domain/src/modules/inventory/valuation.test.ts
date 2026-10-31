import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import { defineCurrency, parseCurrencyCode } from "../../kernel/currency.js";
import { Money } from "../../kernel/money.js";
import {
  allocateProportionalMinor,
  emptyInventoryValuation,
  hasEverBeenValued,
  parseStockValuationKind,
  restoreStockValuation,
} from "./valuation.js";

describe("allocateProportionalMinor (perpetual WAC, ADR-009 section 18)", () => {
  it("uses HALF_EVEN for a partial removal (accountant example L: 530000 x 1 / 15)", () => {
    expect(allocateProportionalMinor(530_000n, 1n, 15n)).toBe(35_333n);
  });

  it("removes the entire remaining value when the last units leave", () => {
    expect(allocateProportionalMinor(99n, 3n, 3n)).toBe(99n);
    expect(allocateProportionalMinor(1n, 1n, 1n)).toBe(1n);
  });

  it("returns 0 when no quantity is taken", () => {
    expect(allocateProportionalMinor(3_500_00n, 0n, 10n)).toBe(0n);
  });

  it("ties to even (HALF_EVEN) and never uses Number", () => {
    expect(allocateProportionalMinor(5n, 1n, 2n)).toBe(2n);
    expect(allocateProportionalMinor(7n, 1n, 2n)).toBe(4n);
  });

  it("works for a 0-decimal currency (JPY) and a large bigint", () => {
    const yen = defineCurrency("JPY", 0);
    expect(yen.minorUnitDigits).toBe(0);
    expect(allocateProportionalMinor(10_000n, 3n, 7n)).toBe(4_286n);
    const huge = 9_007_199_254_740_991n * 1000n;
    expect(allocateProportionalMinor(huge, 1n, 1n)).toBe(huge);
  });

  it("rejects a zero on-hand denominator, a negative quantity, or taking more than on hand", () => {
    expect(() => allocateProportionalMinor(100n, 1n, 0n)).toThrow(DomainError);
    expect(() => allocateProportionalMinor(100n, -1n, 10n)).toThrow(DomainError);
    expect(() => allocateProportionalMinor(100n, 11n, 10n)).toThrow(DomainError);
  });
});

describe("emptyInventoryValuation", () => {
  it("is UNVALUED with zero value and has never been valued", () => {
    const state = emptyInventoryValuation({
      businessId: "019a0000-0000-7000-8000-000000000001" as never,
      locationId: "019a0000-0000-7000-8000-000000000002" as never,
      variantId: "019a0000-0000-7000-8000-000000000003" as never,
      currency: parseCurrencyCode("NGN"),
    });
    expect(state.status).toBe("UNVALUED");
    expect(state.value.equals(Money.zero(parseCurrencyCode("NGN")))).toBe(true);
    expect(state.version).toBe(0);
    expect(hasEverBeenValued(state)).toBe(false);
  });
});

describe("restoreStockValuation", () => {
  const ngn = parseCurrencyCode("NGN");
  const base = {
    id: "019a0000-0000-7000-8000-000000000010" as never,
    businessId: "019a0000-0000-7000-8000-000000000001" as never,
    locationId: "019a0000-0000-7000-8000-000000000002" as never,
    variantId: "019a0000-0000-7000-8000-000000000003" as never,
    quantityAtValuationMinor: 10n,
    balanceVersionAtValuation: 1,
    reason: "test",
    journalEntryId: undefined,
    actorMembershipId: "019a0000-0000-7000-8000-000000000004" as never,
    sourceChannel: "api",
    correlationId: "corr",
    occurredAt: new Date("2026-10-18T08:00:00.000Z"),
    businessDate: { toString: () => "2026-10-18" } as never,
    recordedAt: new Date("2026-10-18T08:00:00.000Z"),
  };

  it("accepts REVERSAL_RESIDUAL with a trigger and zero new value, including a negative previous value", () => {
    expect(parseStockValuationKind("REVERSAL_RESIDUAL")).toBe("REVERSAL_RESIDUAL");
    const document = restoreStockValuation({
      ...base,
      kind: "REVERSAL_RESIDUAL",
      triggerMovementId: "019a0000-0000-7000-8000-000000000020" as never,
      previousValue: Money.ofMinor(-260n, ngn),
      newValue: Money.zero(ngn),
    });
    expect(document.triggerMovementId).toBe("019a0000-0000-7000-8000-000000000020");
  });

  it("rejects a residual without a trigger, a residual with a non-zero new value, and a user kind with a trigger", () => {
    expect(() =>
      restoreStockValuation({
        ...base,
        kind: "REVERSAL_RESIDUAL",
        previousValue: Money.ofMinor(-1n, ngn),
        newValue: Money.zero(ngn),
      }),
    ).toThrow(DomainError);
    expect(() =>
      restoreStockValuation({
        ...base,
        kind: "REVERSAL_RESIDUAL",
        triggerMovementId: "019a0000-0000-7000-8000-000000000020" as never,
        previousValue: Money.ofMinor(-1n, ngn),
        newValue: Money.ofMinor(1n, ngn),
      }),
    ).toThrow(DomainError);
    expect(() =>
      restoreStockValuation({
        ...base,
        kind: "OPERATIONAL",
        triggerMovementId: "019a0000-0000-7000-8000-000000000020" as never,
        previousValue: Money.zero(ngn),
        newValue: Money.ofMinor(1n, ngn),
      }),
    ).toThrow(DomainError);
    expect(() =>
      restoreStockValuation({
        ...base,
        kind: "INITIAL_OPENING",
        previousValue: Money.ofMinor(-1n, ngn),
        newValue: Money.zero(ngn),
      }),
    ).toThrow(DomainError);
  });
});
