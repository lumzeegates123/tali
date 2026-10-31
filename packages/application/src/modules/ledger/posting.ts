import {
  BusinessDate,
  Money,
  createPostingPlan,
  parseJournalEntryId,
  parseUuid,
  reversePostingPlan,
  type JournalEntryId,
  type PostingPlan,
  type SystemAccountRole,
} from "@tali/domain";
import type { BusinessContext } from "../../context/business-context.js";
import { ConflictError, LedgerNotProvisionedError, ValidationError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { TransactionScope } from "../../ports/unit-of-work.js";
import type {
  JournalEntry,
  JournalEntryKind,
  JournalLine,
  JournalRepository,
  JournalSourceRef,
  LedgerAccountRepository,
} from "./ports.js";
import { JOURNAL_SOURCE_KINDS } from "./ports.js";

export interface PostJournalRequest {
  readonly plan: PostingPlan;
  readonly source: JournalSourceRef;
  readonly postingRule: string;
  readonly postingRuleVersion: number;
  readonly description: string;
  readonly entryKind?: JournalEntryKind;
  /** Required when entryKind is REVERSAL. */
  readonly reversesEntryId?: JournalEntryId | string;
  /**
   * Authoritative occurrence time. Defaults to the server clock (online Build 3;
   * ADR-009 section 15). Callers never pass a device-reported time here.
   */
  readonly occurredAt?: Date;
  /**
   * Pre-generated entry identity. Used when a cyclic FK requires the journal
   * id to be known before insert (stock valuations, ADR-009 section 13).
   */
  readonly entryId?: JournalEntryId | string;
}

export interface PostJournalResult {
  readonly entry: JournalEntry;
}

/**
 * Internal ledger posting service (ADR-009 sections 3, 14, 17). Not a public
 * use case and not gated by `ledger:read`. Source application services call
 * `post` inside their own authorized, keyed transaction after building a
 * validated `PostingPlan`. There is no generic `ledger:post` permission and no
 * public journal API.
 */
export interface LedgerPostingService {
  /**
   * Resolves roles within the business, re-validates the plan, and inserts one
   * journal entry. Fails closed with `LEDGER_NOT_PROVISIONED` when a required
   * role is missing. Rejects a plan currency that does not match the business.
   */
  post(scope: TransactionScope, context: BusinessContext, request: PostJournalRequest): Promise<PostJournalResult>;
}

export interface LedgerPostingDependencies {
  readonly accounts: LedgerAccountRepository;
  readonly journals: JournalRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const POSTING_RULE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DESCRIPTION = /^[\x20-\x7E]{1,120}$/;

/**
 * Build 3 period-control hook (ADR-009 section 15). Always allows. Future
 * accounting-period close will reject postings into a closed period here.
 */
export function assertPeriodAllowsPosting(businessDate: BusinessDate): void {
  // Build 3 has no accounting periods (ADR-009 section 15). The business date is
  // accepted so the future closed-period check has a single documented call site.
  if (businessDate.year < 1) {
    throw new ConflictError("business date is outside an open accounting period");
  }
}

function requireSource(source: JournalSourceRef): JournalSourceRef {
  if (!(JOURNAL_SOURCE_KINDS as readonly string[]).includes(source.kind)) {
    throw new ValidationError("unknown journal source kind", [{ path: ["source", "kind"], message: "unknown" }]);
  }
  const id = withDomainRules(() => parseUuid(source.id), "source.id");
  return Object.freeze({ kind: source.kind, id });
}

export function createLedgerPostingService(dependencies: LedgerPostingDependencies): LedgerPostingService {
  return {
    async post(scope, context, request) {
      if (request.plan.currency !== context.currency) {
        throw new ValidationError("posting plan currency must match the business currency", [
          { path: ["currency"], message: "CURRENCY_MISMATCH" },
        ]);
      }
      if (!POSTING_RULE.test(request.postingRule)) {
        throw new ValidationError("invalid posting rule name", [{ path: ["postingRule"], message: "invalid" }]);
      }
      if (
        !Number.isSafeInteger(request.postingRuleVersion) ||
        request.postingRuleVersion < 1 ||
        request.postingRuleVersion > 10_000
      ) {
        throw new ValidationError("invalid posting rule version", [
          { path: ["postingRuleVersion"], message: "invalid" },
        ]);
      }
      if (!DESCRIPTION.test(request.description)) {
        throw new ValidationError("invalid journal description", [{ path: ["description"], message: "invalid" }]);
      }

      const entryKind: JournalEntryKind = request.entryKind ?? "ORIGINAL";
      const source = requireSource(request.source);
      const plan = withDomainRules(() =>
        createPostingPlan(
          request.plan.currency,
          request.plan.lines.map((line) => ({
            role: line.role,
            direction: line.direction,
            amount: line.amount,
            ...(line.memoKind === undefined ? {} : { memoKind: line.memoKind }),
          })),
        ),
      );

      const roleSet = new Set<SystemAccountRole>(plan.lines.map((line) => line.role));
      const resolved = new Map<SystemAccountRole, Awaited<ReturnType<LedgerAccountRepository["findByRole"]>>>();
      for (const role of roleSet) {
        const account = await dependencies.accounts.findByRole(scope, context.businessId, role);
        if (account === undefined) {
          throw new LedgerNotProvisionedError();
        }
        if (account.businessId !== context.businessId) {
          // Defensive: repository adapters must already scope by business.
          throw new LedgerNotProvisionedError();
        }
        resolved.set(role, account);
      }

      if (entryKind === "ORIGINAL") {
        const existing = await dependencies.journals.findOriginalBySource(scope, context.businessId, source);
        if (existing !== undefined) {
          throw new ConflictError("an original journal entry already exists for this source");
        }
      }

      let reversesEntryId: JournalEntryId | undefined;
      if (entryKind === "REVERSAL") {
        if (request.reversesEntryId === undefined) {
          throw new ValidationError("a reversal requires reversesEntryId", [
            { path: ["reversesEntryId"], message: "required" },
          ]);
        }
        const rawReversesEntryId = request.reversesEntryId;
        reversesEntryId = withDomainRules(() => parseJournalEntryId(String(rawReversesEntryId)), "reversesEntryId");
        const original = await dependencies.journals.findById(scope, context.businessId, reversesEntryId);
        if (original === undefined || original.entryKind !== "ORIGINAL") {
          throw new ConflictError("reversal target is missing or not an original entry");
        }
        if (source.kind !== original.source.kind || source.id !== original.source.id) {
          throw new ValidationError("reversal source must match the original journal source", [
            { path: ["source"], message: "mismatch" },
          ]);
        }
        if (original.currency !== plan.currency) {
          throw new ValidationError("reversal plan currency must match the original entry", [
            { path: ["plan", "currency"], message: "mismatch" },
          ]);
        }
        // ADR-009 sections 12 and 26: the reversal copies every original line
        // with opposite direction, same account/role, amount and memo. Extra
        // residual lines are not a reversal.
        const expected = reversePostingPlan(
          createPostingPlan(
            original.currency,
            original.lines.map((line) => ({
              role: line.systemRole,
              direction: line.direction,
              amount: line.amount,
              ...(line.memoKind === undefined ? {} : { memoKind: line.memoKind }),
            })),
          ),
        );
        const mirrors =
          expected.lines.length === plan.lines.length &&
          expected.lines.every((line, index) => {
            const actual = plan.lines[index];
            return (
              actual !== undefined &&
              line.role === actual.role &&
              line.direction === actual.direction &&
              line.amount.equals(actual.amount) &&
              line.memoKind === actual.memoKind
            );
          });
        if (!mirrors) {
          throw new ValidationError("reversal plan must mirror the original entry", [
            { path: ["plan"], message: "mirror mismatch" },
          ]);
        }
      } else if (request.reversesEntryId !== undefined) {
        throw new ValidationError("only a reversal may set reversesEntryId", [
          { path: ["reversesEntryId"], message: "forbidden" },
        ]);
      }

      const occurredAt = request.occurredAt ?? dependencies.clock.now();
      if (Number.isNaN(occurredAt.getTime())) {
        throw new ValidationError("occurredAt must be a valid instant", [{ path: ["occurredAt"], message: "invalid" }]);
      }
      const recordedAt = dependencies.clock.now();
      const businessDate = BusinessDate.fromInstant(occurredAt, context.timeZone);
      assertPeriodAllowsPosting(businessDate);

      const lines: JournalLine[] = plan.lines.map((line, index) => {
        const account = resolved.get(line.role);
        if (account === undefined) {
          throw new LedgerNotProvisionedError();
        }
        return Object.freeze({
          lineNumber: index + 1,
          accountId: account.id,
          systemRole: line.role,
          direction: line.direction,
          amount: line.amount,
          ...(line.memoKind === undefined ? {} : { memoKind: line.memoKind }),
        });
      });

      const debit = Money.sum(
        context.currency,
        lines.filter((line) => line.direction === "DEBIT").map((line) => line.amount),
      );
      const credit = Money.sum(
        context.currency,
        lines.filter((line) => line.direction === "CREDIT").map((line) => line.amount),
      );
      if (!debit.equals(credit)) {
        throw new ConflictError("journal entry is unbalanced");
      }

      const membershipId = context.actor.type === "user" ? context.actor.membershipId : undefined;
      const locationId = context.locationId;

      const entry: JournalEntry = Object.freeze({
        id:
          request.entryId === undefined
            ? dependencies.ids.newId("JournalEntry")
            : withDomainRules(() => parseJournalEntryId(String(request.entryId)), "entryId"),
        businessId: context.businessId,
        currency: context.currency,
        occurredAt,
        businessDate: businessDate.toString(),
        recordedAt,
        entryKind,
        source,
        ...(reversesEntryId === undefined ? {} : { reversesEntryId }),
        postingRule: request.postingRule,
        postingRuleVersion: request.postingRuleVersion,
        description: request.description,
        ...(membershipId === undefined ? {} : { actorMembershipId: membershipId }),
        ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
        ...(locationId === undefined ? {} : { locationId }),
        sourceChannel: context.sourceChannel,
        correlationId: context.correlationId,
        lines: Object.freeze(lines),
      });

      await dependencies.journals.insert(scope, entry);
      return { entry };
    },
  };
}
