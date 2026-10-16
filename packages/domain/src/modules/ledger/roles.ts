import { DomainError } from "../../errors.js";
import type { AccountType } from "./account-type.js";

/**
 * Stable system account roles (ADR-009 section 5). Posting rules name a role;
 * the posting service resolves it to the business's account. Codes and names
 * are display data only.
 */
export const SYSTEM_ACCOUNT_ROLES = [
  "CASH_ON_HAND",
  "BANK_TRANSFER_PENDING",
  "POS_CARD_CLEARING",
  "OTHER_TENDER_CLEARING",
  "INVENTORY",
  "SALES_REVENUE",
  "SALES_DISCOUNTS",
  "TAX_PAYABLE",
  "COST_OF_GOODS_SOLD",
  "INVENTORY_SHRINKAGE",
  "INVENTORY_GAIN",
  "OPENING_BALANCE_EQUITY",
  "GOODS_RECEIVED_NOT_INVOICED",
] as const;

export type SystemAccountRole = (typeof SYSTEM_ACCOUNT_ROLES)[number];

const TYPE_BY_ROLE: Readonly<Record<SystemAccountRole, AccountType>> = Object.freeze({
  CASH_ON_HAND: "ASSET",
  BANK_TRANSFER_PENDING: "ASSET",
  POS_CARD_CLEARING: "ASSET",
  OTHER_TENDER_CLEARING: "ASSET",
  INVENTORY: "ASSET",
  SALES_REVENUE: "REVENUE",
  SALES_DISCOUNTS: "CONTRA_REVENUE",
  TAX_PAYABLE: "LIABILITY",
  COST_OF_GOODS_SOLD: "EXPENSE",
  INVENTORY_SHRINKAGE: "EXPENSE",
  INVENTORY_GAIN: "REVENUE",
  OPENING_BALANCE_EQUITY: "EQUITY",
  GOODS_RECEIVED_NOT_INVOICED: "LIABILITY",
});

export function accountTypeForRole(role: SystemAccountRole): AccountType {
  return TYPE_BY_ROLE[role];
}

export function parseSystemAccountRole(value: string): SystemAccountRole {
  if (!(SYSTEM_ACCOUNT_ROLES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "unknown system account role", "systemRole");
  }
  return value as SystemAccountRole;
}

export function isSystemAccountRole(value: string): value is SystemAccountRole {
  return (SYSTEM_ACCOUNT_ROLES as readonly string[]).includes(value);
}
