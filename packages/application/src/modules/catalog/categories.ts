import type { ProductCategory } from "@tali/domain";
import {
  archiveCategory,
  createCategory,
  parseBusinessId,
  parseCategoryName,
  parseProductCategoryId,
  renameCategory,
  restoreCategory,
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
import { instantAt, integerAt, objectAt, textAt } from "../../idempotency/result-json.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { TransactionScope, UnitOfWork } from "../../ports/unit-of-work.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership, requireUserActor } from "../business/index.js";
import { catalogPermissions } from "../identity/index.js";
import { productCategoryArchived, productCategoryCreated, productCategoryUpdated } from "./audit-actions.js";
import { CATEGORY_NOT_FOUND, categoryIdOrNotFound, parseExpectedVersion } from "./catalog-common.js";
import type { ProductCategoryRepository } from "./ports.js";

export const CREATE_CATEGORY_OPERATION = "product_category.create.v1";
export const CREATE_CATEGORY_COMMAND_SCHEMA_VERSION = 1;

export interface CreateCategoryOutcome {
  readonly category: ProductCategory;
  readonly replayed: boolean;
}

export interface CategoryChangeResult {
  readonly category: ProductCategory;
  /** False for a successful no-op: nothing written, no audit record, no version increment. */
  readonly changed: boolean;
}

/** `product:manage`. Keyed. Names are unique among the business's ACTIVE categories, case-insensitively. */
export interface CreateCategory {
  execute(
    context: BusinessContext,
    input: { readonly name: string; readonly idempotencyKey: string | undefined },
  ): Promise<CreateCategoryOutcome>;
}

/** `product:manage`. Renames a category; state-setting with expectedVersion. */
export interface UpdateCategory {
  execute(
    context: BusinessContext,
    input: { readonly categoryId: string; readonly expectedVersion: number; readonly name: string },
  ): Promise<CategoryChangeResult>;
}

/** `product:manage`. Products keep an archived category; it is no longer offered for new assignment. */
export interface ArchiveCategory {
  execute(
    context: BusinessContext,
    input: { readonly categoryId: string; readonly expectedVersion: number },
  ): Promise<CategoryChangeResult>;
}

export const categoryResultCodec: IdempotentResultCodec<ProductCategory> = {
  encode(category) {
    return {
      category: {
        id: category.id,
        businessId: category.businessId,
        name: category.name,
        status: category.status,
        version: category.version,
        createdAt: category.createdAt.toISOString(),
        updatedAt: category.updatedAt.toISOString(),
      },
    };
  },
  decode(stored) {
    const c = objectAt(objectAt(stored, "result")["category"], "category");
    return restoreCategory({
      id: parseProductCategoryId(textAt(c, "id")),
      businessId: parseBusinessId(textAt(c, "businessId")),
      name: textAt(c, "name"),
      status: textAt(c, "status"),
      version: integerAt(c, "version"),
      createdAt: instantAt(c, "createdAt"),
      updatedAt: instantAt(c, "updatedAt"),
    });
  },
};

async function requireNameAvailable(
  scope: TransactionScope,
  categories: ProductCategoryRepository,
  category: Pick<ProductCategory, "businessId" | "normalizedName"> & { readonly id?: ProductCategory["id"] },
): Promise<void> {
  const holder = await categories.findActiveIdByName(scope, category.businessId, category.normalizedName);
  if (holder !== undefined && holder !== category.id) {
    throw new ConflictError("An active category with this name already exists");
  }
}

export function createCreateCategory(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly categories: ProductCategoryRepository;
  readonly idempotency: KeyedIdempotency;
  readonly hasher: FingerprintHasher;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}): CreateCategory {
  const permission = catalogPermissions.permissions["product:manage"];
  return {
    async execute(context, input) {
      const actor = requireUserActor(context, permission);
      const key = requireIdempotencyKey(input.idempotencyKey);
      const name = withDomainRules(() => parseCategoryName(input.name), "name");
      const command = canonicalCommandEncoding({
        operation: CREATE_CATEGORY_OPERATION,
        commandSchemaVersion: CREATE_CATEGORY_COMMAND_SCHEMA_VERSION,
        command: { name },
      });
      const fingerprint = await dependencies.hasher.fingerprint(command);
      return dependencies.unitOfWork.run(async (scope): Promise<CreateCategoryOutcome> => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        const outcome = await dependencies.idempotency.runBusinessScoped(scope, {
          businessId: context.businessId,
          actor: idempotencyActorOf(actor),
          key,
          command,
          fingerprint,
          resourceType: "product_category",
          codec: categoryResultCodec,
          plan: async () => {
            const category = createCategory({
              id: dependencies.ids.newId("ProductCategory"),
              businessId: context.businessId,
              name,
              now: dependencies.clock.now(),
            });
            await requireNameAvailable(scope, dependencies.categories, category);
            return {
              result: category,
              resourceId: category.id,
              apply: async () => {
                await dependencies.categories.insert(scope, category);
                await dependencies.audit.recordBusinessEvent(scope, productCategoryCreated, {
                  ...businessAuditEnvelope(context, key),
                  entityId: category.id,
                  payload: { name: category.name },
                });
              },
            };
          },
        });
        return { category: outcome.result, replayed: outcome.replayed };
      });
    },
  };
}

export function createUpdateCategory(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly categories: ProductCategoryRepository;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
}): UpdateCategory {
  const permission = catalogPermissions.permissions["product:manage"];
  return {
    async execute(context, input) {
      requireUserActor(context, permission);
      const categoryId = categoryIdOrNotFound(input.categoryId);
      const expectedVersion = parseExpectedVersion(input.expectedVersion);
      const name = withDomainRules(() => parseCategoryName(input.name), "name");
      return dependencies.unitOfWork.run(async (scope) => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        const category = await dependencies.categories.findByIdForUpdate(scope, context.businessId, categoryId);
        if (category === undefined) throw new NotFoundError(CATEGORY_NOT_FOUND);
        const transition = withDomainRules(() =>
          renameCategory({ category, expectedVersion, name, now: dependencies.clock.now() }),
        );
        if (transition.outcome === "unchanged") return { category, changed: false };
        if (transition.category.status === "ACTIVE") {
          await requireNameAvailable(scope, dependencies.categories, transition.category);
        }
        await dependencies.categories.update(scope, category, transition.category);
        await dependencies.audit.recordBusinessEvent(scope, productCategoryUpdated, {
          ...businessAuditEnvelope(context),
          entityId: category.id,
          payload: { fromName: category.name, toName: transition.category.name },
        });
        return { category: transition.category, changed: true };
      });
    },
  };
}

export function createArchiveCategory(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly categories: ProductCategoryRepository;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
}): ArchiveCategory {
  const permission = catalogPermissions.permissions["product:manage"];
  return {
    async execute(context, input) {
      requireUserActor(context, permission);
      const categoryId = categoryIdOrNotFound(input.categoryId);
      const expectedVersion = parseExpectedVersion(input.expectedVersion);
      return dependencies.unitOfWork.run(async (scope) => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        const category = await dependencies.categories.findByIdForUpdate(scope, context.businessId, categoryId);
        if (category === undefined) throw new NotFoundError(CATEGORY_NOT_FOUND);
        const transition = withDomainRules(() =>
          archiveCategory({ category, expectedVersion, now: dependencies.clock.now() }),
        );
        if (transition.outcome === "unchanged") return { category, changed: false };
        await dependencies.categories.update(scope, category, transition.category);
        await dependencies.audit.recordBusinessEvent(scope, productCategoryArchived, {
          ...businessAuditEnvelope(context),
          entityId: category.id,
          payload: {},
        });
        return { category: transition.category, changed: true };
      });
    },
  };
}
