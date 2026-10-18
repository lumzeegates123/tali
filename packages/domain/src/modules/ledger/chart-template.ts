import { DomainError } from "../../errors.js";
import type { AccountType } from "./account-type.js";
import type { SystemAccountRole } from "./roles.js";
import { SYSTEM_ACCOUNT_ROLES, accountTypeForRole, isSystemAccountRole } from "./roles.js";

/** One row of a versioned chart-of-accounts template (ADR-009 section 6). */
export interface ChartTemplateAccount {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly systemRole: SystemAccountRole;
}

/** Immutable, tenant-free chart template. Currency is never embedded. */
export interface ChartTemplate {
  readonly version: number;
  readonly accounts: readonly ChartTemplateAccount[];
}

/** Loose input accepted by the validator so incomplete/invalid fixtures can be rejected at runtime. */
export interface ChartTemplateInput {
  readonly version: number;
  readonly accounts: readonly {
    readonly code: string;
    readonly name: string;
    readonly type: string;
    readonly systemRole: string;
  }[];
}

/**
 * Build 3 chart template version 1: codes and names from the accountant review
 * pack (section 3), roles and types from ADR-009 sections 5 and 6.
 */
const CHART_TEMPLATE_V1_ACCOUNTS: readonly ChartTemplateAccount[] = Object.freeze([
  Object.freeze({ code: "1000", name: "Cash on hand", type: "ASSET", systemRole: "CASH_ON_HAND" }),
  Object.freeze({
    code: "1010",
    name: "Bank transfers pending verification",
    type: "ASSET",
    systemRole: "BANK_TRANSFER_PENDING",
  }),
  Object.freeze({ code: "1020", name: "POS/card clearing", type: "ASSET", systemRole: "POS_CARD_CLEARING" }),
  Object.freeze({ code: "1030", name: "Other tender clearing", type: "ASSET", systemRole: "OTHER_TENDER_CLEARING" }),
  Object.freeze({ code: "1200", name: "Inventory", type: "ASSET", systemRole: "INVENTORY" }),
  Object.freeze({ code: "2100", name: "Tax payable", type: "LIABILITY", systemRole: "TAX_PAYABLE" }),
  Object.freeze({
    code: "2200",
    name: "Goods received not invoiced",
    type: "LIABILITY",
    systemRole: "GOODS_RECEIVED_NOT_INVOICED",
  }),
  Object.freeze({
    code: "3000",
    name: "Opening balance equity",
    type: "EQUITY",
    systemRole: "OPENING_BALANCE_EQUITY",
  }),
  Object.freeze({ code: "4000", name: "Sales revenue", type: "REVENUE", systemRole: "SALES_REVENUE" }),
  Object.freeze({ code: "4010", name: "Sales discounts", type: "CONTRA_REVENUE", systemRole: "SALES_DISCOUNTS" }),
  Object.freeze({ code: "4100", name: "Inventory gains", type: "REVENUE", systemRole: "INVENTORY_GAIN" }),
  Object.freeze({ code: "5000", name: "Cost of goods sold", type: "EXPENSE", systemRole: "COST_OF_GOODS_SOLD" }),
  Object.freeze({ code: "5100", name: "Inventory shrinkage", type: "EXPENSE", systemRole: "INVENTORY_SHRINKAGE" }),
]);

/**
 * Validates a Build 3 system chart template: exactly the accepted
 * `SYSTEM_ACCOUNT_ROLE` set, unique codes, role→type mapping, and normal
 * balance consistency. No currency or tenant may appear on the template object.
 */
export function assertValidChartTemplate(template: ChartTemplateInput): ChartTemplate {
  if (!Number.isSafeInteger(template.version) || template.version < 1) {
    throw new DomainError("INVALID_VALUE", "chart template version must be a positive integer", "version");
  }
  if (template.accounts.length === 0) {
    throw new DomainError("INVALID_VALUE", "chart template must list at least one account", "accounts");
  }

  const codes = new Set<string>();
  const roles = new Set<SystemAccountRole>();
  const normalized: ChartTemplateAccount[] = [];

  for (const account of template.accounts) {
    if (!isSystemAccountRole(account.systemRole)) {
      throw new DomainError("INVALID_VALUE", `unknown chart template role ${account.systemRole}`, "systemRole");
    }
    const systemRole = account.systemRole;
    const type = accountTypeForRole(systemRole);
    if (account.type !== type) {
      throw new DomainError("INVALID_VALUE", `chart template type for ${systemRole} must be ${type}`, "type");
    }
    if (codes.has(account.code)) {
      throw new DomainError("INVALID_VALUE", `duplicate chart template code ${account.code}`, "code");
    }
    if (roles.has(systemRole)) {
      throw new DomainError("INVALID_VALUE", `duplicate chart template role ${systemRole}`, "systemRole");
    }
    codes.add(account.code);
    roles.add(systemRole);
    normalized.push(
      Object.freeze({
        code: account.code,
        name: account.name,
        type,
        systemRole,
      }),
    );
  }

  if (roles.size !== SYSTEM_ACCOUNT_ROLES.length) {
    throw new DomainError(
      "INVALID_VALUE",
      `chart template must contain exactly ${SYSTEM_ACCOUNT_ROLES.length} system roles`,
      "accounts",
    );
  }
  for (const role of SYSTEM_ACCOUNT_ROLES) {
    if (!roles.has(role)) {
      throw new DomainError("INVALID_VALUE", `chart template is missing system role ${role}`, "systemRole");
    }
  }

  return Object.freeze({
    version: template.version,
    accounts: Object.freeze(normalized),
  });
}

export const CHART_TEMPLATE_V1: ChartTemplate = assertValidChartTemplate({
  version: 1,
  accounts: CHART_TEMPLATE_V1_ACCOUNTS,
});

/** Every Build 3 system role appears exactly once in template version 1. */
export function chartTemplateV1Roles(): readonly SystemAccountRole[] {
  return SYSTEM_ACCOUNT_ROLES;
}

/** The template for a version this application knows, or undefined. */
export function findChartTemplate(version: number): ChartTemplate | undefined {
  return version === CHART_TEMPLATE_V1.version ? CHART_TEMPLATE_V1 : undefined;
}

export function chartTemplateByVersion(version: number): ChartTemplate {
  const template = findChartTemplate(version);
  if (template !== undefined) return template;
  throw new DomainError("INVALID_VALUE", `unknown chart template version ${version}`, "templateVersion");
}
