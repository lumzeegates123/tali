import type { Business, BusinessLocation, BusinessMembership } from "@tali/domain";
import {
  createFoundingOwnerMembership,
  foundBusiness,
  parseBusinessId,
  parseBusinessName,
  parseBusinessTimeZoneId,
  parseCurrencyCode,
  parseLocationId,
  parseMembershipId,
  parseUserId,
  restoreBusiness,
  restoreLocation,
  restoreMembership,
} from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import type { AuthenticatedUserContext } from "../../context/authenticated-user-context.js";
import type { UserActor } from "../../context/business-context.js";
import { ValidationError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import { canonicalCommandEncoding } from "../../idempotency/canonical-command.js";
import type { FingerprintHasher } from "../../idempotency/fingerprint-hasher.js";
import { requireIdempotencyKey } from "../../idempotency/idempotency-key.js";
import type { IdempotentResultCodec, KeyedIdempotency } from "../../idempotency/keyed-idempotency.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { JsonValue } from "../../ports/queue-provider.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { UserRepository } from "../identity/index.js";
import { requireActiveUser } from "../identity/index.js";
import type { DefaultLocationCreation } from "../location/index.js";
import { businessCreated, membershipCreated } from "./audit-actions.js";
import type { BusinessRepository, CurrencyReferenceRepository, MembershipRepository } from "./ports.js";

export const CREATE_BUSINESS_OPERATION = "business.create.v1";
export const CREATE_BUSINESS_COMMAND_SCHEMA_VERSION = 1;

export interface CreateBusinessInput {
  readonly name: string;
  readonly currencyCode: string;
  readonly timeZone: string;
  /** The Idempotency-Key header value; required (ADR-004 section 4.1). */
  readonly idempotencyKey: string | undefined;
}

export interface CreateBusinessResult {
  readonly business: Business;
  readonly location: BusinessLocation;
  readonly membership: BusinessMembership;
}

export interface CreateBusinessOutcome {
  readonly result: CreateBusinessResult;
  /** True when an earlier attempt with the same key is being replayed. */
  readonly replayed: boolean;
}

/**
 * Creates a business, its single ACTIVE default location and the creator's
 * ACTIVE OWNER membership in one transaction (ADR-005 section 5), keyed by
 * the caller's idempotency key in user scope (ADR-004 section 4.2). Any
 * active registered user may create a business; no business permission
 * applies because the business does not exist yet.
 */
export interface CreateBusiness {
  execute(context: AuthenticatedUserContext, input: CreateBusinessInput): Promise<CreateBusinessOutcome>;
}

type JsonObject = { readonly [key: string]: JsonValue };

function field(object: JsonObject, name: string): JsonValue {
  const value = object[name];
  if (value === undefined) throw new Error(`stored result is missing "${name}"`);
  return value;
}

function text(object: JsonObject, name: string): string {
  const value = field(object, name);
  if (typeof value !== "string") throw new Error(`stored result "${name}" is not a string`);
  return value;
}

function objectAt(value: JsonValue, name: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`stored result "${name}" is not an object`);
  }
  return value as JsonObject;
}

const instant = (object: JsonObject, name: string): Date => new Date(text(object, name));

/** Stores the created records as JSON and restores them, revalidated, on replay. */
export const createBusinessResultCodec: IdempotentResultCodec<CreateBusinessResult> = {
  encode({ business, location, membership }) {
    return {
      business: {
        id: business.id,
        name: business.name,
        currencyCode: business.currencyCode,
        timeZone: business.timeZone,
        status: business.status,
        createdByUserId: business.createdByUserId,
        createdAt: business.createdAt.toISOString(),
        updatedAt: business.updatedAt.toISOString(),
      },
      location: {
        id: location.id,
        businessId: location.businessId,
        name: location.name,
        isDefault: location.isDefault,
        status: location.status,
        createdAt: location.createdAt.toISOString(),
        updatedAt: location.updatedAt.toISOString(),
      },
      membership: {
        id: membership.id,
        businessId: membership.businessId,
        userId: membership.userId,
        role: membership.role,
        status: membership.status,
        version: membership.version,
        createdAt: membership.createdAt.toISOString(),
        updatedAt: membership.updatedAt.toISOString(),
      },
    };
  },
  decode(stored) {
    const root = objectAt(stored, "result");
    const b = objectAt(field(root, "business"), "business");
    const l = objectAt(field(root, "location"), "location");
    const m = objectAt(field(root, "membership"), "membership");
    const isDefault = field(l, "isDefault");
    const version = field(m, "version");
    if (typeof isDefault !== "boolean" || typeof version !== "number") {
      throw new Error("stored result has an invalid location or membership");
    }
    return {
      business: restoreBusiness({
        id: parseBusinessId(text(b, "id")),
        name: text(b, "name"),
        currencyCode: text(b, "currencyCode"),
        timeZone: text(b, "timeZone"),
        status: text(b, "status"),
        createdByUserId: parseUserId(text(b, "createdByUserId")),
        createdAt: instant(b, "createdAt"),
        updatedAt: instant(b, "updatedAt"),
      }),
      location: restoreLocation({
        id: parseLocationId(text(l, "id")),
        businessId: parseBusinessId(text(l, "businessId")),
        name: text(l, "name"),
        isDefault,
        status: text(l, "status"),
        createdAt: instant(l, "createdAt"),
        updatedAt: instant(l, "updatedAt"),
      }),
      membership: restoreMembership({
        id: parseMembershipId(text(m, "id")),
        businessId: parseBusinessId(text(m, "businessId")),
        userId: parseUserId(text(m, "userId")),
        role: text(m, "role"),
        status: text(m, "status"),
        version,
        createdAt: instant(m, "createdAt"),
        updatedAt: instant(m, "updatedAt"),
      }),
    };
  },
};

export function createCreateBusiness(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly users: UserRepository;
  readonly businesses: BusinessRepository;
  readonly memberships: MembershipRepository;
  readonly currencies: CurrencyReferenceRepository;
  readonly defaultLocation: DefaultLocationCreation;
  readonly idempotency: KeyedIdempotency;
  readonly hasher: FingerprintHasher;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}): CreateBusiness {
  return {
    async execute(context, input) {
      const key = requireIdempotencyKey(input.idempotencyKey);
      const name = withDomainRules(() => parseBusinessName(input.name), "name");
      const currencyCode = withDomainRules(() => parseCurrencyCode(input.currencyCode), "currencyCode");
      const timeZone = withDomainRules(() => parseBusinessTimeZoneId(input.timeZone), "timeZone");

      const command = canonicalCommandEncoding({
        operation: CREATE_BUSINESS_OPERATION,
        commandSchemaVersion: CREATE_BUSINESS_COMMAND_SCHEMA_VERSION,
        command: { name, currencyCode, timeZone },
      });
      const fingerprint = await dependencies.hasher.fingerprint(command);

      return dependencies.unitOfWork.run(async (scope) => {
        requireActiveUser(await dependencies.users.findById(scope, context.userId));

        return dependencies.idempotency.runUserScoped(scope, {
          userId: context.userId,
          key,
          command,
          fingerprint,
          resourceType: "business",
          codec: createBusinessResultCodec,
          plan: async () => {
            if ((await dependencies.currencies.findByCode(scope, currencyCode)) === undefined) {
              throw new ValidationError("The currency is not supported", [
                { path: ["currencyCode"], message: "unsupported" },
              ]);
            }
            const now = dependencies.clock.now();
            const business = foundBusiness({
              id: dependencies.ids.newId("Business"),
              name,
              currencyCode,
              timeZone,
              createdByUserId: context.userId,
              now,
            });
            const location = dependencies.defaultLocation.prepare(business, now);
            const membership = createFoundingOwnerMembership({
              id: dependencies.ids.newId("Membership"),
              businessId: business.id,
              userId: context.userId,
              now,
            });
            const actor: UserActor = { type: "user", userId: context.userId, membershipId: membership.id };
            const audit = {
              actor,
              sourceChannel: context.sourceChannel,
              correlationId: context.correlationId,
              idempotencyKey: key,
            } as const;

            return {
              result: { business, location, membership },
              resourceId: business.id,
              apply: async () => {
                await dependencies.businesses.insert(scope, business);
                await dependencies.defaultLocation.insert(scope, location);
                await dependencies.memberships.insert(scope, membership);
                await dependencies.audit.recordBusinessEvent(scope, businessCreated, {
                  ...audit,
                  businessId: business.id,
                  entityId: business.id,
                  payload: {
                    currencyCode: business.currencyCode,
                    timeZone: business.timeZone,
                    status: business.status,
                  },
                });
                await dependencies.defaultLocation.recordCreated(scope, location, audit);
                await dependencies.audit.recordBusinessEvent(scope, membershipCreated, {
                  ...audit,
                  businessId: business.id,
                  entityId: membership.id,
                  payload: { userId: membership.userId, role: membership.role, status: membership.status },
                });
              },
            };
          },
        });
      });
    },
  };
}
