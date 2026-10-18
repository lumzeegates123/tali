import { StoredLedgerAccountInvalidError, type LedgerAccount, type LedgerAccountRepository } from "@tali/application";
import {
  normalBalanceFor,
  parseAccountType,
  parseBusinessId,
  parseLedgerAccountId,
  parseSystemAccountRole,
} from "@tali/domain";
import type { LedgerAccount as LedgerAccountRow } from "../generated/prisma/client.js";
import { translatingUniqueViolations } from "../errors/unique-violations.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

export const LEDGER_ACCOUNT_CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  ledger_accounts_pkey: "The chart of accounts was provisioned concurrently",
  ledger_accounts_business_id_id_key: "The chart of accounts was provisioned concurrently",
  ledger_accounts_business_id_code_key: "The chart of accounts was provisioned concurrently",
  ledger_accounts_business_id_system_role_key: "The chart of accounts was provisioned concurrently",
});

/**
 * Every Build 3 account carries a system role (ADR-009 section 6); a row the
 * domain cannot restore fails loudly (StoredLedgerAccountInvalidError) instead
 * of being guessed at.
 */
export function toLedgerAccount(row: LedgerAccountRow): LedgerAccount {
  if (row.systemRole === null) throw new StoredLedgerAccountInvalidError("stored ledger account has no system role");
  try {
    const type = parseAccountType(row.type);
    if (row.normalBalance !== normalBalanceFor(type)) {
      throw new StoredLedgerAccountInvalidError("stored ledger account normal balance does not match its type");
    }
    if (row.status !== "ACTIVE")
      throw new StoredLedgerAccountInvalidError("stored ledger account status is not recognized");
    return {
      id: parseLedgerAccountId(row.id),
      businessId: parseBusinessId(row.businessId),
      code: row.code,
      name: row.name,
      type,
      normalBalance: normalBalanceFor(type),
      systemRole: parseSystemAccountRole(row.systemRole),
      templateVersion: row.templateVersion,
      status: "ACTIVE",
      createdAt: row.createdAt,
    };
  } catch (error) {
    if (error instanceof StoredLedgerAccountInvalidError) throw error;
    throw new StoredLedgerAccountInvalidError("stored ledger account cannot be restored");
  }
}

/**
 * Tenant-owned ledger accounts (ADR-009 section 6). Append-only for the
 * application role: it holds SELECT and INSERT only, so an account is never
 * renamed, retyped or removed in place. A concurrent provisioning that loses
 * the unique-role race surfaces as ConflictError.
 */
export function createLedgerAccountRepository(): LedgerAccountRepository {
  return {
    async findByRole(scope, businessId, role) {
      const row = await transactionClient(scope).ledgerAccount.findUnique({
        where: { businessId_systemRole: { businessId, systemRole: role } },
      });
      return row === null ? undefined : toLedgerAccount(row);
    },

    async listByBusiness(scope, businessId) {
      const rows = await transactionClient(scope).ledgerAccount.findMany({
        where: { businessId },
        orderBy: [{ code: "asc" }],
      });
      return rows.map(toLedgerAccount);
    },

    async listProvisionedTemplateVersions(scope, businessId) {
      const rows = await transactionClient(scope).ledgerAccount.groupBy({
        by: ["templateVersion"],
        where: { businessId },
        orderBy: { templateVersion: "asc" },
      });
      return rows.map((row) => row.templateVersion);
    },

    async insertMany(scope, accounts) {
      if (accounts.length === 0) return;
      await translatingUniqueViolations(LEDGER_ACCOUNT_CONFLICTS, () =>
        transactionClient(scope).ledgerAccount.createMany({
          data: accounts.map((account) => ({
            businessId: account.businessId,
            id: account.id,
            code: account.code,
            name: account.name,
            type: account.type,
            normalBalance: account.normalBalance,
            systemRole: account.systemRole,
            templateVersion: account.templateVersion,
            status: account.status,
            createdAt: account.createdAt,
          })),
        }),
      );
    },
  };
}
