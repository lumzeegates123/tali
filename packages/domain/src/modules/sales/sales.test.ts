import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import { KernelError } from "../../kernel/errors.js";
import { parseId } from "../../kernel/ids.js";
import { Money } from "../../kernel/money.js";
import { Quantity } from "../../kernel/quantity.js";
import { parseCurrencyCode } from "../../kernel/currency.js";
import { RoundingMode } from "../../kernel/rounding.js";
import { parseUnitCode } from "../../kernel/unit.js";
import { reversePostingPlan } from "../ledger/index.js";
import { lineDiscountAmount, lineGross, revenueAmount } from "./amounts.js";
import { parseSaleId } from "./ids.js";
import { formatOnlineReceiptNumber, parseOnlineReceiptNumber } from "./receipt-number.js";
import { buildSaleLine, type SaleLine } from "./sale.js";
import {
  aggregateCostStatus,
  onlineNegativeStockPolicy,
  planSaleStock,
  planSaleStockReversal,
  reversalResidualCase,
  type PlannedSaleStockEffect,
  type SaleStockPosition,
} from "./stock-plan.js";
import { noTaxSnapshot, type SaleTaxSnapshot } from "./tax.js";
import { salePostedPlan } from "./posting.js";
import { createSaleTender } from "./tender.js";
import type { LineDiscount } from "./amounts.js";

const NGN = parseCurrencyCode("NGN");
const JPY = parseCurrencyCode("JPY");
const PIECE = parseUnitCode("PIECE");

let sequence = 0;

function id<Entity extends string>(entity: Entity) {
  sequence += 1;
  return parseId(entity, `01900000-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`);
}

function ngn(amount: bigint): Money {
  return Money.ofMinor(amount, NGN);
}

function line(props: {
  readonly price: bigint;
  readonly quantity: bigint;
  readonly scale?: number;
  readonly unit?: typeof PIECE;
  readonly currency?: typeof NGN;
  readonly discount?: LineDiscount;
  readonly tax?: SaleTaxSnapshot;
  readonly tracked?: boolean;
  readonly cost?: bigint;
  readonly costStatus?: SaleLine["costStatus"];
  readonly lineNumber?: number;
}): SaleLine {
  const currency = props.currency ?? NGN;
  const tracked = props.tracked ?? false;
  const unitPrice = Money.ofMinor(props.price, currency);
  return buildSaleLine(
    {
      lineNumber: props.lineNumber ?? 1,
      variantId: id("ProductVariant"),
      productName: "Rice",
      tracked,
      quantity: Quantity.ofMinor(props.quantity, props.unit ?? PIECE),
      unitScale: props.scale ?? 0,
      unitPrice,
      priceVersion: 1,
      discount: props.discount ?? { kind: "NONE" },
      ...(props.tax === undefined ? {} : { tax: props.tax }),
      costStatus: props.costStatus ?? (tracked ? "UNVALUED" : "NOT_APPLICABLE"),
      ...(props.cost === undefined ? {} : { cost: Money.ofMinor(props.cost, currency) }),
      ...(tracked ? { movementId: id("InventoryMovement"), valuationVersionRead: 1 } : {}),
    },
    currency,
  );
}

function cash(amount: bigint, cashReceived?: bigint) {
  return createSaleTender({
    tenderNumber: 1,
    method: "CASH",
    amount: ngn(amount),
    ...(cashReceived === undefined ? {} : { cashReceived: ngn(cashReceived) }),
  });
}

function roles(plan: ReturnType<typeof salePostedPlan>) {
  return plan.lines.map((entry) => [entry.role, entry.direction, entry.amount.amountMinor, entry.memoKind]);
}

describe("sale line gross", () => {
  it("multiplies whole units with no remainder", () => {
    expect(lineGross(ngn(50_000n), 2n, 0).amountMinor).toBe(100_000n);
  });

  it("rounds a fractional stock unit once, HALF_EVEN", () => {
    expect(lineGross(ngn(1_000n), 1_500n, 3).amountMinor).toBe(1_500n);
    expect(lineGross(ngn(1n), 2_500n, 3).amountMinor).toBe(2n);
  });

  it("keeps a large minor-unit product exact", () => {
    const price = 10n ** 18n;
    expect(lineGross(ngn(price), 3n, 0).amountMinor).toBe(price * 3n);
  });

  it("uses the same integer path for a zero-decimal currency", () => {
    expect(lineGross(Money.ofMinor(100n, JPY), 3n, 0).amountMinor).toBe(300n);
    expect(lineGross(Money.ofMinor(1n, JPY), 2_500n, 3).amountMinor).toBe(2n);
  });
});

describe("sale line discounts", () => {
  const gross = ngn(100_000n);

  it("accepts a fixed discount strictly below the gross", () => {
    expect(lineDiscountAmount(gross, { kind: "FIXED", amount: ngn(1n) }).amountMinor).toBe(1n);
    expect(lineDiscountAmount(gross, { kind: "FIXED", amount: ngn(99_999n) }).amountMinor).toBe(99_999n);
  });

  it("rejects a zero, equal or larger fixed discount", () => {
    for (const amount of [0n, 100_000n, 100_001n]) {
      expect(() => lineDiscountAmount(gross, { kind: "FIXED", amount: ngn(amount) })).toThrow(DomainError);
    }
  });

  it("accepts 1 and 9999 basis points when the rounded discount stays below the gross", () => {
    expect(lineDiscountAmount(gross, { kind: "BASIS_POINTS", basisPoints: 1 }).amountMinor).toBe(10n);
    expect(lineDiscountAmount(gross, { kind: "BASIS_POINTS", basisPoints: 9999 }).amountMinor).toBe(99_990n);
  });

  it("rejects 0 and 10000 basis points", () => {
    expect(() => lineDiscountAmount(gross, { kind: "BASIS_POINTS", basisPoints: 0 })).toThrow(DomainError);
    expect(() => lineDiscountAmount(gross, { kind: "BASIS_POINTS", basisPoints: 10_000 })).toThrow(DomainError);
  });

  it("rejects a basis-point discount that HALF_EVEN rounds up to the gross", () => {
    expect(() => lineDiscountAmount(ngn(1n), { kind: "BASIS_POINTS", basisPoints: 9999 })).toThrow(DomainError);
  });
});

describe("sale tenders", () => {
  it("snapshots cash received and change without changing the tender amount", () => {
    const tender = cash(100_000n, 120_000n);
    expect(tender.amount.amountMinor).toBe(100_000n);
    expect(tender.changeGiven?.amountMinor).toBe(20_000n);
    expect(tender.verificationStatus).toBe("NOT_APPLICABLE");
  });

  it("allows cash with no cash received and rejects a short cash received", () => {
    expect(cash(100_000n).cashReceived).toBeUndefined();
    expect(() => cash(100_000n, 99_999n)).toThrow(DomainError);
  });

  it("rejects cash received on a non-cash tender and marks it unverified", () => {
    const transfer = createSaleTender({ tenderNumber: 1, method: "BANK_TRANSFER", amount: ngn(100_000n) });
    expect(transfer.verificationStatus).toBe("NOT_VERIFIED");
    expect(() =>
      createSaleTender({
        tenderNumber: 1,
        method: "POS_CARD",
        amount: ngn(100_000n),
        cashReceived: ngn(100_000n),
      }),
    ).toThrow(DomainError);
  });
});

describe("sale stock plan", () => {
  const variant = id("ProductVariant");

  function position(overrides: Partial<SaleStockPosition> = {}): SaleStockPosition {
    return {
      variantId: variant,
      quantityMinor: 10n,
      balanceVersion: 1,
      valuationStatus: "VALUED",
      valueMinor: 350_000n,
      valuationVersion: 1,
      ...overrides,
    };
  }

  function request(quantity: bigint, lineNumber = 1) {
    return { lineNumber, variantId: variant, quantityMinor: quantity, movementId: id("InventoryMovement") };
  }

  it("blocks every business and product", () => {
    expect(onlineNegativeStockPolicy()).toBe("BLOCK");
  });

  it("removes WAC value with last-unit exactness", () => {
    const plan = planSaleStock([request(2n)], new Map([[variant, position()]]));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.effects[0]).toMatchObject({
      quantityDeltaMinor: -2n,
      quantityAfterMinor: 8n,
      costStatus: "VALUED",
      costMinor: 70_000n,
      valueDeltaMinor: -70_000n,
      nextValueMinor: 280_000n,
      nextValuationStatus: "VALUED",
    });
    const rest = planSaleStock(
      [request(8n)],
      new Map([
        [variant, position({ quantityMinor: 8n, valueMinor: 280_000n, balanceVersion: 2, valuationVersion: 2 })],
      ]),
    );
    if (!rest.ok) throw new Error("expected the remaining units to sell");
    expect(rest.effects[0]?.costMinor).toBe(280_000n);
    expect((plan.effects[0]?.costMinor ?? 0n) + (rest.effects[0]?.costMinor ?? 0n)).toBe(350_000n);
  });

  it("applies two lines of the same variant in order against the running position", () => {
    const small = id("ProductVariant");
    const plan = planSaleStock(
      [
        { lineNumber: 1, variantId: small, quantityMinor: 2n, movementId: id("InventoryMovement") },
        { lineNumber: 2, variantId: small, quantityMinor: 1n, movementId: id("InventoryMovement") },
      ],
      new Map([
        [
          small,
          {
            variantId: small,
            quantityMinor: 3n,
            balanceVersion: 4,
            valuationStatus: "VALUED",
            valueMinor: 100n,
            valuationVersion: 4,
          },
        ],
      ]),
    );
    if (!plan.ok) throw new Error("expected both lines");
    expect(plan.effects.map((effect) => effect.costMinor)).toEqual([67n, 33n]);
    expect(plan.effects.map((effect) => effect.quantityAfterMinor)).toEqual([1n, 0n]);
    expect((plan.effects[0]?.costMinor ?? 0n) + (plan.effects[1]?.costMinor ?? 0n)).toBe(100n);
    expect(plan.effects[1]?.nextValueMinor).toBe(0n);
  });

  it("leaves an unvalued projection's recorded value untouched and posts no cost", () => {
    const plan = planSaleStock(
      [request(2n)],
      new Map([[variant, position({ valuationStatus: "UNVALUED", valueMinor: 999n })]]),
    );
    if (!plan.ok) throw new Error("expected the unvalued sale");
    expect(plan.effects[0]).toMatchObject({
      costStatus: "UNVALUED",
      valueDeltaMinor: 0n,
      nextValueMinor: 999n,
      nextValuationStatus: "UNVALUED",
      quantityAfterMinor: 8n,
    });
    expect(plan.effects[0]?.costMinor).toBeUndefined();
  });

  it("rejects the whole sale when any tracked line would go negative", () => {
    const plan = planSaleStock([request(11n)], new Map([[variant, position()]]));
    expect(plan).toEqual({ ok: false, shortages: [{ variantId: variant, availableQuantityMinor: 10n }] });
  });

  it("aggregates cost status from tracked lines only", () => {
    expect(aggregateCostStatus([{ tracked: false, costStatus: "NOT_APPLICABLE" }])).toBe("NOT_APPLICABLE");
    expect(aggregateCostStatus([{ tracked: true, costStatus: "VALUED" }])).toBe("VALUED");
    expect(aggregateCostStatus([{ tracked: true, costStatus: "UNVALUED" }])).toBe("UNVALUED");
    expect(
      aggregateCostStatus([
        { tracked: true, costStatus: "VALUED" },
        { tracked: true, costStatus: "UNVALUED" },
        { tracked: false, costStatus: "NOT_APPLICABLE" },
      ]),
    ).toBe("PARTIAL");
  });
});

describe("sale stock reversal", () => {
  it("classifies residual cases without a sales-specific policy", () => {
    expect(reversalResidualCase(0n, 5n, "VALUED")).toBe("C");
    expect(reversalResidualCase(4n, -1n, "VALUED")).toBe("B");
    expect(reversalResidualCase(4n, 5n, "VALUED")).toBe("NONE");
    expect(reversalResidualCase(0n, 5n, "UNVALUED")).toBe("NONE");
  });

  it("adds the snapshotted cost back and cannot reach case B or C from a non-negative position", () => {
    const variant = id("ProductVariant");
    const sold = planSaleStock(
      [{ lineNumber: 1, variantId: variant, quantityMinor: 2n, movementId: id("InventoryMovement") }],
      new Map([
        [
          variant,
          {
            variantId: variant,
            quantityMinor: 10n,
            balanceVersion: 1,
            valuationStatus: "VALUED" as const,
            valueMinor: 350_000n,
            valuationVersion: 1,
          },
        ],
      ]),
    );
    if (!sold.ok) throw new Error("expected a sale");
    const effect = sold.effects[0] as PlannedSaleStockEffect;
    const after: SaleStockPosition = {
      variantId: variant,
      quantityMinor: effect.quantityAfterMinor,
      balanceVersion: effect.nextBalanceVersion,
      valuationStatus: effect.nextValuationStatus,
      valueMinor: effect.nextValueMinor,
      valuationVersion: effect.nextValuationVersion,
    };
    const reversal = planSaleStockReversal([effect], new Map([[variant, after]]));
    expect(reversal[0]).toMatchObject({
      quantityDeltaMinor: 2n,
      quantityAfterMinor: 10n,
      valueDeltaMinor: 70_000n,
      nextValueMinor: 350_000n,
      nextValuationStatus: "VALUED",
    });
    expect(
      reversalResidualCase(reversal[0]?.quantityAfterMinor ?? 0n, reversal[0]?.nextValueMinor ?? 0n, "VALUED"),
    ).toBe("NONE");
  });

  it("keeps an unvalued current projection unvalued even when the snapshotted cost changes the recorded value", () => {
    const variant = id("ProductVariant");
    const effect: PlannedSaleStockEffect = {
      lineNumber: 1,
      movementId: id("InventoryMovement"),
      variantId: variant,
      quantityDeltaMinor: -2n,
      quantityAfterMinor: 8n,
      balanceVersionRead: 1,
      nextBalanceVersion: 2,
      costStatus: "VALUED",
      costMinor: 70_000n,
      valuationVersionRead: 1,
      valueDeltaMinor: -70_000n,
      nextValueMinor: 280_000n,
      nextValuationStatus: "VALUED",
      nextValuationVersion: 2,
    };
    const reversal = planSaleStockReversal(
      [effect],
      new Map([
        [
          variant,
          {
            variantId: variant,
            quantityMinor: 8n,
            balanceVersion: 2,
            valuationStatus: "UNVALUED",
            valueMinor: 100n,
            valuationVersion: 9,
          },
        ],
      ]),
    );
    expect(reversal[0]).toMatchObject({
      nextValuationStatus: "UNVALUED",
      nextValueMinor: 70_100n,
      valueDeltaMinor: 70_000n,
      quantityAfterMinor: 10n,
    });
  });
});

describe("SALE_POSTED v1", () => {
  function valued(cost = 70_000n, discount?: LineDiscount, tax?: SaleTaxSnapshot): SaleLine {
    return line({
      price: 50_000n,
      quantity: 2n,
      tracked: true,
      cost,
      costStatus: "VALUED",
      ...(discount === undefined ? {} : { discount }),
      ...(tax === undefined ? {} : { tax }),
    });
  }

  it("A posts cash, revenue and valued COGS", () => {
    const sold = valued();
    const plan = salePostedPlan({ currency: NGN, lines: [sold], tenders: [cash(sold.total.amountMinor)] });
    expect(roles(plan)).toEqual([
      ["CASH_ON_HAND", "DEBIT", 100_000n, "TENDER_CASH"],
      ["SALES_REVENUE", "CREDIT", 100_000n, "REVENUE"],
      ["COST_OF_GOODS_SOLD", "DEBIT", 70_000n, "COGS"],
      ["INVENTORY", "CREDIT", 70_000n, "INVENTORY"],
    ]);
    expect(plan.debitTotal().equals(plan.creditTotal())).toBe(true);
  });

  it("B, C and OTHER debit the method's clearing role", () => {
    const sold = valued();
    const amount = sold.total;
    expect(
      roles(
        salePostedPlan({
          currency: NGN,
          lines: [sold],
          tenders: [createSaleTender({ tenderNumber: 1, method: "BANK_TRANSFER", amount })],
        }),
      )[0],
    ).toEqual(["BANK_TRANSFER_PENDING", "DEBIT", 100_000n, "TENDER_BANK_TRANSFER"]);
    expect(
      roles(
        salePostedPlan({
          currency: NGN,
          lines: [sold],
          tenders: [createSaleTender({ tenderNumber: 1, method: "POS_CARD", amount })],
        }),
      )[0],
    ).toEqual(["POS_CARD_CLEARING", "DEBIT", 100_000n, "TENDER_POS_CARD"]);
    expect(
      roles(
        salePostedPlan({
          currency: NGN,
          lines: [sold],
          tenders: [createSaleTender({ tenderNumber: 1, method: "OTHER", amount })],
        }),
      )[0],
    ).toEqual(["OTHER_TENDER_CLEARING", "DEBIT", 100_000n, "TENDER_OTHER"]);
  });

  it("D splits tenders and aggregates two tenders of one method", () => {
    const sold = valued();
    const plan = salePostedPlan({
      currency: NGN,
      lines: [sold],
      tenders: [
        createSaleTender({ tenderNumber: 1, method: "CASH", amount: ngn(60_000n) }),
        createSaleTender({ tenderNumber: 2, method: "BANK_TRANSFER", amount: ngn(40_000n) }),
      ],
    });
    expect(roles(plan).slice(0, 2)).toEqual([
      ["CASH_ON_HAND", "DEBIT", 60_000n, "TENDER_CASH"],
      ["BANK_TRANSFER_PENDING", "DEBIT", 40_000n, "TENDER_BANK_TRANSFER"],
    ]);
    const aggregated = salePostedPlan({
      currency: NGN,
      lines: [sold],
      tenders: [
        createSaleTender({ tenderNumber: 1, method: "CASH", amount: ngn(60_000n) }),
        createSaleTender({ tenderNumber: 2, method: "CASH", amount: ngn(40_000n) }),
      ],
    });
    expect(aggregated.lines.filter((entry) => entry.role === "CASH_ON_HAND")).toHaveLength(1);
    expect(aggregated.lines[0]?.amount.amountMinor).toBe(100_000n);
  });

  it("E posts the discount contra-revenue and ignores cash change", () => {
    const sold = valued(70_000n, { kind: "BASIS_POINTS", basisPoints: 1000 });
    expect(sold.discountAmount.amountMinor).toBe(10_000n);
    expect(sold.total.amountMinor).toBe(90_000n);
    const tender = cash(90_000n, 100_000n);
    expect(tender.changeGiven?.amountMinor).toBe(10_000n);
    const plan = salePostedPlan({ currency: NGN, lines: [sold], tenders: [tender] });
    expect(roles(plan)).toEqual([
      ["CASH_ON_HAND", "DEBIT", 90_000n, "TENDER_CASH"],
      ["SALES_DISCOUNTS", "DEBIT", 10_000n, "DISCOUNT"],
      ["SALES_REVENUE", "CREDIT", 100_000n, "REVENUE"],
      ["COST_OF_GOODS_SOLD", "DEBIT", 70_000n, "COGS"],
      ["INVENTORY", "CREDIT", 70_000n, "INVENTORY"],
    ]);
  });

  it("F is the exact mirror of A", () => {
    const sold = valued();
    const original = salePostedPlan({ currency: NGN, lines: [sold], tenders: [cash(sold.total.amountMinor)] });
    const reversal = reversePostingPlan(original);
    expect(
      reversal.lines.map((entry, index) => [
        entry.role,
        entry.direction,
        entry.amount.equals(original.lines[index]?.amount ?? ngn(0n)),
      ]),
    ).toEqual(original.lines.map((entry) => [entry.role, entry.direction === "DEBIT" ? "CREDIT" : "DEBIT", true]));
    expect(reversal.debitTotal().equals(original.debitTotal())).toBe(true);
  });

  it("G omits COGS when the tracked line is unvalued and omits tax for NO_TAX", () => {
    const sold = line({ price: 50_000n, quantity: 2n, tracked: true, costStatus: "UNVALUED" });
    expect(sold.tax.taxKind).toBe("NONE");
    expect(sold.cost).toBeUndefined();
    const plan = salePostedPlan({ currency: NGN, lines: [sold], tenders: [cash(sold.total.amountMinor)] });
    expect(roles(plan)).toEqual([
      ["CASH_ON_HAND", "DEBIT", 100_000n, "TENDER_CASH"],
      ["SALES_REVENUE", "CREDIT", 100_000n, "REVENUE"],
    ]);
  });

  it("H posts an illustrative exclusive tax snapshot without a tax configuration", () => {
    const net = ngn(90_000n);
    const sold = valued(
      70_000n,
      { kind: "BASIS_POINTS", basisPoints: 1000 },
      {
        taxKind: "STANDARD",
        taxName: "illustrative",
        taxRateBps: 1000,
        taxPricingMode: "EXCLUSIVE",
        taxRoundingMode: "HALF_EVEN",
        taxableBase: net,
        tax: ngn(9_000n),
      },
    );
    expect(sold.total.amountMinor).toBe(99_000n);
    const plan = salePostedPlan({ currency: NGN, lines: [sold], tenders: [cash(99_000n)] });
    expect(roles(plan)).toEqual([
      ["CASH_ON_HAND", "DEBIT", 99_000n, "TENDER_CASH"],
      ["SALES_DISCOUNTS", "DEBIT", 10_000n, "DISCOUNT"],
      ["SALES_REVENUE", "CREDIT", 100_000n, "REVENUE"],
      ["TAX_PAYABLE", "CREDIT", 9_000n, "TAX"],
      ["COST_OF_GOODS_SOLD", "DEBIT", 70_000n, "COGS"],
      ["INVENTORY", "CREDIT", 70_000n, "INVENTORY"],
    ]);
    expect(plan.debitTotal().equals(plan.creditTotal())).toBe(true);
  });

  it("I posts an illustrative inclusive tax snapshot", () => {
    const gross = ngn(100_000n);
    const tax = gross.multiplyByFraction(1_000n, 11_000n, RoundingMode.HALF_EVEN);
    expect(tax.amountMinor).toBe(9_091n);
    const sold = valued(70_000n, undefined, {
      taxKind: "STANDARD",
      taxName: "illustrative",
      taxRateBps: 1000,
      taxPricingMode: "INCLUSIVE",
      taxRoundingMode: "HALF_EVEN",
      taxableBase: gross,
      tax,
    });
    expect(revenueAmount(sold.gross, sold.taxAmount, "INCLUSIVE").amountMinor).toBe(90_909n);
    const plan = salePostedPlan({ currency: NGN, lines: [sold], tenders: [cash(100_000n)] });
    expect(roles(plan)).toEqual([
      ["CASH_ON_HAND", "DEBIT", 100_000n, "TENDER_CASH"],
      ["SALES_REVENUE", "CREDIT", 90_909n, "REVENUE"],
      ["TAX_PAYABLE", "CREDIT", 9_091n, "TAX"],
      ["COST_OF_GOODS_SOLD", "DEBIT", 70_000n, "COGS"],
      ["INVENTORY", "CREDIT", 70_000n, "INVENTORY"],
    ]);
    expect(plan.debitTotal().equals(plan.creditTotal())).toBe(true);
  });
});

describe("sale identity", () => {
  it("requires a UUIDv7 sale id and an online receipt number of at least six digits", () => {
    expect(() => parseSaleId("01900000-0000-4000-8000-000000000001")).toThrow(KernelError);
    expect(formatOnlineReceiptNumber(1n)).toBe("S-000001");
    expect(formatOnlineReceiptNumber(2n)).toBe("S-000002");
    expect(parseOnlineReceiptNumber("S-000001")).toBe("S-000001");
    expect(() => formatOnlineReceiptNumber(0n)).toThrow(DomainError);
    expect(() => parseOnlineReceiptNumber("S-1")).toThrow(DomainError);
    expect(noTaxSnapshot(ngn(1n)).tax.isZero()).toBe(true);
  });
});
