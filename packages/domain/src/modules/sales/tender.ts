import { DomainError } from "../../errors.js";
import type { CurrencyCode } from "../../kernel/currency.js";
import { Money } from "../../kernel/money.js";
import { codePointLength, isWellFormedText } from "../../text.js";

export const TENDER_METHODS = ["CASH", "BANK_TRANSFER", "POS_CARD", "OTHER"] as const;
export type TenderMethod = (typeof TENDER_METHODS)[number];

export const TENDER_VERIFICATION_STATUSES = ["NOT_APPLICABLE", "NOT_VERIFIED"] as const;
export type TenderVerificationStatus = (typeof TENDER_VERIFICATION_STATUSES)[number];

export const MAX_SALE_TENDERS = 10;
export const TENDER_REFERENCE_MAX_LENGTH = 64;

export interface SaleTender {
  readonly tenderNumber: number;
  readonly method: TenderMethod;
  readonly amount: Money;
  readonly reference?: string;
  readonly verificationStatus: TenderVerificationStatus;
  /** Display snapshot only. Never posted. */
  readonly cashReceived?: Money;
  /** Display snapshot only. cashReceived - amount. Never posted. */
  readonly changeGiven?: Money;
}

export function parseTenderReference(value: string): string {
  if (!isWellFormedText(value) || value !== value.trim() || value.length === 0) {
    throw new DomainError("INVALID_VALUE", "tender reference must be trimmed well-formed text", "reference");
  }
  if (codePointLength(value) > TENDER_REFERENCE_MAX_LENGTH) {
    throw new DomainError("INVALID_VALUE", "tender reference must be at most 64 characters", "reference");
  }
  return value;
}

export function tenderVerification(method: TenderMethod): TenderVerificationStatus {
  return method === "CASH" ? "NOT_APPLICABLE" : "NOT_VERIFIED";
}

export function createSaleTender(props: {
  readonly tenderNumber: number;
  readonly method: TenderMethod;
  readonly amount: Money;
  readonly reference?: string;
  readonly cashReceived?: Money;
}): SaleTender {
  if (!Number.isSafeInteger(props.tenderNumber) || props.tenderNumber < 1 || props.tenderNumber > MAX_SALE_TENDERS) {
    throw new DomainError("INVALID_VALUE", "tender number must be from 1 to 10", "tenderNumber");
  }
  if (!(TENDER_METHODS as readonly string[]).includes(props.method)) {
    throw new DomainError("INVALID_VALUE", "unknown tender method", "method");
  }
  if (!props.amount.isPositive()) {
    throw new DomainError("INVALID_VALUE", "tender amount must be positive", "amount");
  }
  const reference = props.reference === undefined ? undefined : parseTenderReference(props.reference);
  if (props.method === "CASH") {
    if (props.cashReceived === undefined) {
      return Object.freeze({
        tenderNumber: props.tenderNumber,
        method: props.method,
        amount: props.amount,
        verificationStatus: "NOT_APPLICABLE" as const,
        ...(reference === undefined ? {} : { reference }),
      });
    }
    if (props.cashReceived.currency !== props.amount.currency) {
      throw new DomainError("INVALID_VALUE", "cash received currency must match the tender", "cashReceived");
    }
    if (props.cashReceived.amountMinor < props.amount.amountMinor) {
      throw new DomainError("INVALID_VALUE", "cash received must be at least the tender amount", "cashReceived");
    }
    return Object.freeze({
      tenderNumber: props.tenderNumber,
      method: props.method,
      amount: props.amount,
      verificationStatus: "NOT_APPLICABLE" as const,
      cashReceived: props.cashReceived,
      changeGiven: props.cashReceived.subtract(props.amount),
      ...(reference === undefined ? {} : { reference }),
    });
  }
  if (props.cashReceived !== undefined) {
    throw new DomainError("INVALID_VALUE", "only a cash tender may record cash received", "cashReceived");
  }
  return Object.freeze({
    tenderNumber: props.tenderNumber,
    method: props.method,
    amount: props.amount,
    verificationStatus: tenderVerification(props.method),
    ...(reference === undefined ? {} : { reference }),
  });
}

export function sumTenderAmounts(currency: CurrencyCode, tenders: readonly SaleTender[]): Money {
  return Money.sum(
    currency,
    tenders.map((tender) => tender.amount),
  );
}
