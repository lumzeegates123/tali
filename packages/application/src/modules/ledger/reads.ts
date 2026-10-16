import {
  Money,
  parseJournalEntryId,
  type CurrencyCode,
  type JournalEntryId,
  type LedgerAccountId,
  type SystemAccountRole,
} from "@tali/domain";
import type { BusinessContext } from "../../context/business-context.js";
import { requireContextPermission } from "../../context/business-context.js";
import { NotFoundError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import { ledgerPermissions } from "../identity/index.js";
import type { JournalEntry, JournalRepository, LedgerAccount, LedgerAccountRepository } from "./ports.js";

export interface LedgerAccountView {
  readonly id: LedgerAccountId;
  readonly code: string;
  readonly name: string;
  readonly type: LedgerAccount["type"];
  readonly normalBalance: LedgerAccount["normalBalance"];
  readonly systemRole: SystemAccountRole;
  readonly templateVersion: number;
  readonly status: LedgerAccount["status"];
}

export interface AccountBalanceView {
  readonly accountId: LedgerAccountId;
  readonly systemRole: SystemAccountRole;
  readonly code: string;
  readonly name: string;
  readonly currency: CurrencyCode;
  /** Debit total of all lines for this account. */
  readonly debitTotal: Money;
  /** Credit total of all lines for this account. */
  readonly creditTotal: Money;
  /**
   * Signed balance in the account's normal-balance sense: positive means the
   * account holds a normal balance (ADR-009 section 16 derives; no cache).
   */
  readonly balance: Money;
}

export interface JournalEntryView {
  readonly entry: JournalEntry;
}

export interface ListLedgerAccounts {
  execute(context: BusinessContext): Promise<readonly LedgerAccountView[]>;
}

export interface ListAccountBalances {
  execute(context: BusinessContext): Promise<readonly AccountBalanceView[]>;
}

export interface GetJournalEntry {
  execute(context: BusinessContext, input: { readonly entryId: string }): Promise<JournalEntryView>;
}

export interface LedgerReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: LedgerAccountRepository;
  readonly journals: JournalRepository;
}

const readPermission = ledgerPermissions.permissions["ledger:read"];

function requireLedgerRead(context: BusinessContext): BusinessContext {
  requireContextPermission(context, readPermission);
  return context;
}

function toAccountView(account: LedgerAccount): LedgerAccountView {
  return Object.freeze({
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    normalBalance: account.normalBalance,
    systemRole: account.systemRole,
    templateVersion: account.templateVersion,
    status: account.status,
  });
}

export function createListLedgerAccounts(dependencies: LedgerReadDependencies): ListLedgerAccounts {
  return {
    async execute(context) {
      requireLedgerRead(context);
      return dependencies.unitOfWork.run(async (scope) => {
        const accounts = await dependencies.accounts.listByBusiness(scope, context.businessId);
        return Object.freeze(accounts.map(toAccountView));
      });
    },
  };
}

export function createListAccountBalances(dependencies: LedgerReadDependencies): ListAccountBalances {
  return {
    async execute(context) {
      requireLedgerRead(context);
      return dependencies.unitOfWork.run(async (scope) => {
        const accounts = await dependencies.accounts.listByBusiness(scope, context.businessId);
        const lines = await dependencies.journals.listLinesForBusiness(scope, context.businessId);
        const byAccount = new Map<LedgerAccountId, { debit: Money; credit: Money }>();
        for (const account of accounts) {
          byAccount.set(account.id, {
            debit: Money.zero(context.currency),
            credit: Money.zero(context.currency),
          });
        }
        for (const line of lines) {
          const bucket = byAccount.get(line.accountId);
          if (bucket === undefined) continue;
          if (line.direction === "DEBIT") {
            bucket.debit = bucket.debit.add(line.amount);
          } else {
            bucket.credit = bucket.credit.add(line.amount);
          }
        }
        return Object.freeze(
          accounts.map((account) => {
            const totals = byAccount.get(account.id) ?? {
              debit: Money.zero(context.currency),
              credit: Money.zero(context.currency),
            };
            const balance =
              account.normalBalance === "DEBIT"
                ? totals.debit.subtract(totals.credit)
                : totals.credit.subtract(totals.debit);
            return Object.freeze({
              accountId: account.id,
              systemRole: account.systemRole,
              code: account.code,
              name: account.name,
              currency: context.currency,
              debitTotal: totals.debit,
              creditTotal: totals.credit,
              balance,
            });
          }),
        );
      });
    },
  };
}

export function createGetJournalEntry(dependencies: LedgerReadDependencies): GetJournalEntry {
  return {
    async execute(context, input) {
      requireLedgerRead(context);
      const entryId = withDomainRules(() => parseJournalEntryId(input.entryId), "entryId");
      return dependencies.unitOfWork.run(async (scope) => {
        const entry = await dependencies.journals.findById(scope, context.businessId, entryId);
        if (entry === undefined) {
          throw new NotFoundError();
        }
        return { entry };
      });
    },
  };
}

export type { JournalEntryId };
