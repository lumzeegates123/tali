import type { ProductPack } from "@tali/domain";
import {
  createPack,
  parseBusinessId,
  parsePackFactor,
  parsePackName,
  parseProductPackId,
  parseProductVariantId,
  restorePack,
  retirePack,
} from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { BusinessContext } from "../../context/business-context.js";
import { ConflictError, NotFoundError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import { idempotencyActorOf } from "../../idempotency/business-idempotency-store.js";
import { canonicalCommandEncoding } from "../../idempotency/canonical-command.js";
import type { FingerprintHasher } from "../../idempotency/fingerprint-hasher.js";
import { requireIdempotencyKey } from "../../idempotency/idempotency-key.js";
import type { IdempotentResultCodec, KeyedIdempotency } from "../../idempotency/keyed-idempotency.js";
import { instantAt, objectAt, textAt } from "../../idempotency/result-json.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership, requireUserActor } from "../business/index.js";
import { catalogPermissions } from "../identity/index.js";
import { productPackAdded, productPackRetired } from "./audit-actions.js";
import {
  PACK_NOT_FOUND,
  packIdOrNotFound,
  parseFactorMinor,
  PRODUCT_NOT_FOUND,
  productIdOrNotFound,
} from "./catalog-common.js";
import type { ProductPackRepository, ProductRepository } from "./ports.js";

export const ADD_PACK_OPERATION = "product_pack.add.v1";
export const ADD_PACK_COMMAND_SCHEMA_VERSION = 1;

export interface AddPackOutcome {
  readonly pack: ProductPack;
  readonly replayed: boolean;
}

export interface PackChangeResult {
  readonly pack: ProductPack;
  /** False for the successful no-op of retiring a RETIRED pack (no audit record). */
  readonly changed: boolean;
}

/**
 * `product:manage`. Keyed. Adds a data-entry pack to a product's default
 * variant: `factorMinor` minor quantities of its stock unit per pack, a
 * positive integer string from 2 to 10^9 (ADR-008 section 3.4).
 */
export interface AddPack {
  execute(
    context: BusinessContext,
    input: {
      readonly productId: string;
      readonly name: string;
      readonly factorMinor: string;
      readonly idempotencyKey: string | undefined;
    },
  ): Promise<AddPackOutcome>;
}

/**
 * `product:manage`. ACTIVE to RETIRED, one way. Packs carry no version in
 * ADR-008 section 3.4, so retirement takes no expectedVersion; retiring a
 * RETIRED pack is a successful no-op.
 */
export interface RetirePack {
  execute(context: BusinessContext, input: { readonly packId: string }): Promise<PackChangeResult>;
}

export const packResultCodec: IdempotentResultCodec<ProductPack> = {
  encode(pack) {
    return {
      pack: {
        id: pack.id,
        businessId: pack.businessId,
        variantId: pack.variantId,
        name: pack.name,
        factorMinor: pack.factorMinor.toString(),
        status: pack.status,
        createdAt: pack.createdAt.toISOString(),
        updatedAt: pack.updatedAt.toISOString(),
      },
    };
  },
  decode(stored) {
    const p = objectAt(objectAt(stored, "result")["pack"], "pack");
    return restorePack({
      id: parseProductPackId(textAt(p, "id")),
      businessId: parseBusinessId(textAt(p, "businessId")),
      variantId: parseProductVariantId(textAt(p, "variantId")),
      name: textAt(p, "name"),
      factorMinor: parseFactorMinor(textAt(p, "factorMinor")),
      status: textAt(p, "status"),
      createdAt: instantAt(p, "createdAt"),
      updatedAt: instantAt(p, "updatedAt"),
    });
  },
};

export function createAddPack(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly products: ProductRepository;
  readonly packs: ProductPackRepository;
  readonly idempotency: KeyedIdempotency;
  readonly hasher: FingerprintHasher;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}): AddPack {
  const permission = catalogPermissions.permissions["product:manage"];
  return {
    async execute(context, input) {
      const actor = requireUserActor(context, permission);
      const key = requireIdempotencyKey(input.idempotencyKey);
      const productId = productIdOrNotFound(input.productId);
      const name = withDomainRules(() => parsePackName(input.name), "name");
      const factorMinor = parseFactorMinor(input.factorMinor);
      withDomainRules(() => parsePackFactor(factorMinor), "factorMinor");
      const command = canonicalCommandEncoding({
        operation: ADD_PACK_OPERATION,
        commandSchemaVersion: ADD_PACK_COMMAND_SCHEMA_VERSION,
        command: { productId, name, factorMinor: factorMinor.toString() },
      });
      const fingerprint = await dependencies.hasher.fingerprint(command);
      return dependencies.unitOfWork.run(async (scope): Promise<AddPackOutcome> => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        const outcome = await dependencies.idempotency.runBusinessScoped(scope, {
          businessId: context.businessId,
          actor: idempotencyActorOf(actor),
          key,
          command,
          fingerprint,
          resourceType: "product_pack",
          codec: packResultCodec,
          plan: async () => {
            const item = await dependencies.products.findByIdForUpdate(scope, context.businessId, productId);
            if (item === undefined) throw new NotFoundError(PRODUCT_NOT_FOUND);
            const duplicate = await dependencies.packs.findActiveIdByName(
              scope,
              context.businessId,
              item.variant.id,
              name,
            );
            if (duplicate !== undefined) throw new ConflictError("An active pack with this name already exists");
            const pack = withDomainRules(() =>
              createPack({
                id: dependencies.ids.newId("ProductPack"),
                variant: item.variant,
                name,
                factorMinor,
                now: dependencies.clock.now(),
              }),
            );
            return {
              result: pack,
              resourceId: pack.id,
              apply: async () => {
                await dependencies.packs.insert(scope, pack);
                await dependencies.audit.recordBusinessEvent(scope, productPackAdded, {
                  ...businessAuditEnvelope(context, key),
                  entityId: pack.id,
                  payload: { variantId: pack.variantId, name: pack.name, factorMinor: pack.factorMinor.toString() },
                });
              },
            };
          },
        });
        return { pack: outcome.result, replayed: outcome.replayed };
      });
    },
  };
}

export function createRetirePack(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly packs: ProductPackRepository;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
}): RetirePack {
  const permission = catalogPermissions.permissions["product:manage"];
  return {
    async execute(context, input) {
      requireUserActor(context, permission);
      const packId = packIdOrNotFound(input.packId);
      return dependencies.unitOfWork.run(async (scope) => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        const pack = await dependencies.packs.findByIdForUpdate(scope, context.businessId, packId);
        if (pack === undefined) throw new NotFoundError(PACK_NOT_FOUND);
        const transition = retirePack({ pack, now: dependencies.clock.now() });
        if (transition.outcome === "unchanged") return { pack, changed: false };
        await dependencies.packs.update(scope, pack, transition.pack);
        await dependencies.audit.recordBusinessEvent(scope, productPackRetired, {
          ...businessAuditEnvelope(context),
          entityId: pack.id,
          payload: { variantId: pack.variantId },
        });
        return { pack: transition.pack, changed: true };
      });
    },
  };
}
