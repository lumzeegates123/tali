import type { Barcode, CatalogProduct, ProductCategoryId, ProductDescription, ProductUpdate, Sku } from "@tali/domain";
import {
  archiveProduct,
  createProduct,
  parseBarcode,
  parseCatalogChangeReason,
  parseProductDescription,
  parseProductName,
  parseSku,
  parseUnitCode,
  reactivateProduct,
  updateProduct,
} from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import { hasPermission } from "../../authorization/permissions.js";
import type { BusinessContext } from "../../context/business-context.js";
import { NotFoundError, PermissionDeniedError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import { idempotencyActorOf } from "../../idempotency/business-idempotency-store.js";
import type { CommandObject } from "../../idempotency/canonical-command.js";
import { canonicalCommandEncoding } from "../../idempotency/canonical-command.js";
import type { FingerprintHasher } from "../../idempotency/fingerprint-hasher.js";
import { requireIdempotencyKey } from "../../idempotency/idempotency-key.js";
import type { KeyedIdempotency } from "../../idempotency/keyed-idempotency.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership, requireUserActor } from "../business/index.js";
import { catalogPermissions, permissionsForRole } from "../identity/index.js";
import {
  productArchived,
  productCreated,
  productPriceSet,
  productReactivated,
  productUpdated,
} from "./audit-actions.js";
import {
  catalogProductCodec,
  categoryIdOrNotFound,
  parseExpectedVersion,
  parseSellingPrice,
  PRODUCT_NOT_FOUND,
  productIdOrNotFound,
  requireAssignableCategory,
  requireBarcodeAvailable,
  requireBoolean,
  requireKnownUnit,
  requireSkuAvailable,
} from "./catalog-common.js";
import type {
  ProductCategoryRepository,
  ProductPackRepository,
  ProductPriceHistoryRepository,
  ProductRepository,
  UnitReferenceRepository,
  VariantInventoryStateReader,
} from "./ports.js";

export const CREATE_PRODUCT_OPERATION = "product.create.v1";
export const CREATE_PRODUCT_COMMAND_SCHEMA_VERSION = 1;

export interface CreateProductInput {
  readonly name: string;
  readonly description?: string;
  readonly categoryId?: string;
  readonly sku?: string;
  readonly barcode?: string;
  readonly stockUnit: string;
  readonly trackInventory: boolean;
  /** Optional first selling price; requires `product:price` as well (ADR-008 section 15). */
  readonly initialPrice?: { readonly amountMinor: string; readonly currency: string };
  readonly idempotencyKey: string | undefined;
}

export interface CreateProductOutcome {
  readonly item: CatalogProduct;
  readonly replayed: boolean;
}

/**
 * `product:manage` (OWNER, MANAGER, STOCK_KEEPER). Creates a product and its
 * hidden default variant in one transaction (ADR-008 section 3.2). Keyed:
 * a retry with the same key and command replays the stored result.
 */
export interface CreateProduct {
  execute(context: BusinessContext, input: CreateProductInput): Promise<CreateProductOutcome>;
}

/**
 * A product edit. An absent field is left alone; `null` clears an optional
 * field. State-setting with optimistic versioning (ADR-008 section 9).
 */
export interface UpdateProductInput {
  readonly productId: string;
  readonly expectedVersion: number;
  readonly name?: string;
  readonly description?: string | null;
  readonly categoryId?: string | null;
  readonly sku?: string | null;
  readonly barcode?: string | null;
  readonly stockUnit?: string;
  readonly trackInventory?: boolean;
}

export interface CatalogProductChangeResult {
  readonly item: CatalogProduct;
  /** False for a successful no-op: nothing written, no audit record, no version increment. */
  readonly changed: boolean;
}

/** `product:manage`. */
export interface UpdateProduct {
  execute(context: BusinessContext, input: UpdateProductInput): Promise<CatalogProductChangeResult>;
}

/** `product:manage`. Archives the product and its default variant together; archive is never deletion. */
export interface ArchiveProduct {
  execute(
    context: BusinessContext,
    input: { readonly productId: string; readonly expectedVersion: number; readonly reason?: string },
  ): Promise<CatalogProductChangeResult>;
}

/** `product:manage`. Reactivates the product and its default variant together. */
export interface ReactivateProduct {
  execute(
    context: BusinessContext,
    input: { readonly productId: string; readonly expectedVersion: number },
  ): Promise<CatalogProductChangeResult>;
}

function optionalParsed<T>(value: string | null | undefined, parse: (raw: string) => T): T | null | undefined {
  if (value === undefined || value === null) return value;
  return parse(value);
}

export function createCreateProduct(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly products: ProductRepository;
  readonly categories: ProductCategoryRepository;
  readonly prices: ProductPriceHistoryRepository;
  readonly units: UnitReferenceRepository;
  readonly idempotency: KeyedIdempotency;
  readonly hasher: FingerprintHasher;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}): CreateProduct {
  const manage = catalogPermissions.permissions["product:manage"];
  const pricePermission = catalogPermissions.permissions["product:price"];
  return {
    async execute(context, input) {
      const actor = requireUserActor(context, manage);
      if (input.initialPrice !== undefined) requireUserActor(context, pricePermission);
      const key = requireIdempotencyKey(input.idempotencyKey);
      const name = withDomainRules(() => parseProductName(input.name), "name");
      const description =
        input.description === undefined
          ? undefined
          : withDomainRules(() => parseProductDescription(input.description as string), "description");
      const sku = input.sku === undefined ? undefined : withDomainRules(() => parseSku(input.sku as string), "sku");
      const barcode =
        input.barcode === undefined
          ? undefined
          : withDomainRules(() => parseBarcode(input.barcode as string), "barcode");
      const stockUnit = withDomainRules(() => parseUnitCode(input.stockUnit), "stockUnit");
      const trackInventory = requireBoolean(input.trackInventory, "trackInventory");
      const categoryId = input.categoryId === undefined ? undefined : categoryIdOrNotFound(input.categoryId);
      const initialPrice =
        input.initialPrice === undefined ? undefined : parseSellingPrice(input.initialPrice, context.currency);

      const commandBody: CommandObject = {
        name,
        description,
        categoryId,
        sku: sku?.value,
        barcode: barcode?.value,
        stockUnit,
        trackInventory,
        initialPrice:
          initialPrice === undefined
            ? undefined
            : { amountMinor: initialPrice.toMinorUnitsString(), currency: initialPrice.currency },
      };
      const command = canonicalCommandEncoding({
        operation: CREATE_PRODUCT_OPERATION,
        commandSchemaVersion: CREATE_PRODUCT_COMMAND_SCHEMA_VERSION,
        command: commandBody,
      });
      const fingerprint = await dependencies.hasher.fingerprint(command);

      return dependencies.unitOfWork.run(async (scope): Promise<CreateProductOutcome> => {
        const membership = await requireActingMembership(scope, dependencies.memberships, context, manage);
        if (initialPrice !== undefined && !hasPermission(permissionsForRole(membership.role), pricePermission)) {
          throw new PermissionDeniedError();
        }
        const outcome = await dependencies.idempotency.runBusinessScoped(scope, {
          businessId: context.businessId,
          actor: idempotencyActorOf(actor),
          key,
          command,
          fingerprint,
          resourceType: "product",
          codec: catalogProductCodec,
          plan: async () => {
            await requireKnownUnit(scope, dependencies.units, stockUnit);
            if (categoryId !== undefined) {
              await requireAssignableCategory(scope, dependencies.categories, context.businessId, categoryId);
            }
            if (sku !== undefined) await requireSkuAvailable(scope, dependencies.products, context.businessId, sku);
            if (barcode !== undefined) {
              await requireBarcodeAvailable(scope, dependencies.products, context.businessId, barcode);
            }
            const created = withDomainRules(() =>
              createProduct({
                id: dependencies.ids.newId("Product"),
                variantId: dependencies.ids.newId("ProductVariant"),
                businessId: context.businessId,
                name,
                ...(description === undefined ? {} : { description }),
                ...(categoryId === undefined ? {} : { categoryId }),
                ...(sku === undefined ? {} : { sku }),
                ...(barcode === undefined ? {} : { barcode }),
                stockUnit,
                trackInventory,
                ...(initialPrice === undefined
                  ? {}
                  : {
                      initialPrice: {
                        id: dependencies.ids.newId("ProductVariantPrice"),
                        price: initialPrice,
                        businessCurrency: context.currency,
                      },
                    }),
                createdByMembershipId: membership.id,
                now: dependencies.clock.now(),
              }),
            );
            const { product, variant } = created.item;
            return {
              result: created.item,
              resourceId: product.id,
              apply: async () => {
                await dependencies.products.insert(scope, created.item);
                await dependencies.audit.recordBusinessEvent(scope, productCreated, {
                  ...businessAuditEnvelope(context, key),
                  entityId: product.id,
                  payload: {
                    variantId: variant.id,
                    name: product.name,
                    ...(variant.sku === undefined ? {} : { sku: variant.sku.value }),
                    ...(variant.barcode === undefined ? {} : { barcode: variant.barcode.value }),
                    stockUnit: variant.stockUnit,
                    trackInventory: variant.trackInventory,
                    ...(product.categoryId === undefined ? {} : { categoryId: product.categoryId }),
                  },
                });
                if (created.priceEntry !== undefined) {
                  await dependencies.prices.append(scope, created.priceEntry);
                  await dependencies.audit.recordBusinessEvent(scope, productPriceSet, {
                    ...businessAuditEnvelope(context, key),
                    entityId: product.id,
                    payload: {
                      variantId: variant.id,
                      toAmountMinor: created.priceEntry.price.toMinorUnitsString(),
                      currency: created.priceEntry.price.currency,
                      priceVersion: created.priceEntry.priceVersion,
                    },
                  });
                }
              },
            };
          },
        });
        return { item: outcome.result, replayed: outcome.replayed };
      });
    },
  };
}

interface ParsedUpdate {
  readonly update: ProductUpdate;
  readonly categoryId: ProductCategoryId | null | undefined;
}

function parseUpdate(input: UpdateProductInput): ParsedUpdate {
  const description = optionalParsed<ProductDescription>(input.description, (raw) =>
    withDomainRules(() => parseProductDescription(raw), "description"),
  );
  const sku = optionalParsed<Sku>(input.sku, (raw) => withDomainRules(() => parseSku(raw), "sku"));
  const barcode = optionalParsed<Barcode>(input.barcode, (raw) => withDomainRules(() => parseBarcode(raw), "barcode"));
  const categoryId = optionalParsed(input.categoryId, categoryIdOrNotFound);
  const update: ProductUpdate = {
    ...(input.name === undefined
      ? {}
      : { name: withDomainRules(() => parseProductName(input.name as string), "name") }),
    ...(description === undefined ? {} : { description }),
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(sku === undefined ? {} : { sku }),
    ...(barcode === undefined ? {} : { barcode }),
    ...(input.stockUnit === undefined
      ? {}
      : { stockUnit: withDomainRules(() => parseUnitCode(input.stockUnit as string), "stockUnit") }),
    ...(input.trackInventory === undefined
      ? {}
      : { trackInventory: requireBoolean(input.trackInventory, "trackInventory") }),
  };
  return { update, categoryId };
}

export function createUpdateProduct(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly products: ProductRepository;
  readonly categories: ProductCategoryRepository;
  readonly packs: ProductPackRepository;
  readonly units: UnitReferenceRepository;
  readonly inventory: VariantInventoryStateReader;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
}): UpdateProduct {
  const permission = catalogPermissions.permissions["product:manage"];
  return {
    async execute(context, input) {
      requireUserActor(context, permission);
      const productId = productIdOrNotFound(input.productId);
      const expectedVersion = parseExpectedVersion(input.expectedVersion);
      const { update, categoryId } = parseUpdate(input);

      return dependencies.unitOfWork.run(async (scope) => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        const item = await dependencies.products.findByIdForUpdate(scope, context.businessId, productId);
        if (item === undefined) throw new NotFoundError(PRODUCT_NOT_FOUND);
        const { variant } = item;
        const unitOrTrackingRequested = update.stockUnit !== undefined || update.trackInventory !== undefined;
        const inventory = unitOrTrackingRequested
          ? await dependencies.inventory.stateOf(scope, context.businessId, variant.id)
          : { hasMovements: false, hasNonZeroBalance: false, hasConfiguredThreshold: false };
        const hasActivePacks =
          update.stockUnit !== undefined && update.stockUnit !== variant.stockUnit
            ? await dependencies.packs.hasActivePacks(scope, context.businessId, variant.id)
            : false;
        const transition = withDomainRules(() =>
          updateProduct({ item, expectedVersion, update, inventory, hasActivePacks, now: dependencies.clock.now() }),
        );
        if (transition.outcome === "unchanged") return { item, changed: false };

        const { changes } = transition;
        const next = transition.item;
        if (changes.category && categoryId !== undefined && categoryId !== null) {
          await requireAssignableCategory(scope, dependencies.categories, context.businessId, categoryId);
        }
        if (changes.stockUnit) await requireKnownUnit(scope, dependencies.units, next.variant.stockUnit);
        if (changes.sku && next.variant.sku !== undefined) {
          await requireSkuAvailable(scope, dependencies.products, context.businessId, next.variant.sku, variant.id);
        }
        if (changes.barcode && next.variant.barcode !== undefined && next.variant.status === "ACTIVE") {
          await requireBarcodeAvailable(
            scope,
            dependencies.products,
            context.businessId,
            next.variant.barcode,
            variant.id,
          );
        }

        await dependencies.products.update(scope, item, next);
        const before = item;
        await dependencies.audit.recordBusinessEvent(scope, productUpdated, {
          ...businessAuditEnvelope(context),
          entityId: item.product.id,
          payload: {
            variantId: variant.id,
            nameChanged: changes.name,
            descriptionChanged: changes.description,
            categoryChanged: changes.category,
            skuChanged: changes.sku,
            barcodeChanged: changes.barcode,
            stockUnitChanged: changes.stockUnit,
            trackInventoryChanged: changes.trackInventory,
            ...(changes.name ? { fromName: before.product.name, toName: next.product.name } : {}),
            ...(changes.category
              ? {
                  ...(before.product.categoryId === undefined ? {} : { fromCategoryId: before.product.categoryId }),
                  ...(next.product.categoryId === undefined ? {} : { toCategoryId: next.product.categoryId }),
                }
              : {}),
            ...(changes.sku
              ? {
                  ...(before.variant.sku === undefined ? {} : { fromSku: before.variant.sku.value }),
                  ...(next.variant.sku === undefined ? {} : { toSku: next.variant.sku.value }),
                }
              : {}),
            ...(changes.barcode
              ? {
                  ...(before.variant.barcode === undefined ? {} : { fromBarcode: before.variant.barcode.value }),
                  ...(next.variant.barcode === undefined ? {} : { toBarcode: next.variant.barcode.value }),
                }
              : {}),
            ...(changes.stockUnit
              ? { fromStockUnit: before.variant.stockUnit, toStockUnit: next.variant.stockUnit }
              : {}),
            ...(changes.trackInventory
              ? { fromTrackInventory: before.variant.trackInventory, toTrackInventory: next.variant.trackInventory }
              : {}),
          },
        });
        return { item: next, changed: true };
      });
    },
  };
}

export function createArchiveProduct(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly products: ProductRepository;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
}): ArchiveProduct {
  const permission = catalogPermissions.permissions["product:manage"];
  return {
    async execute(context, input) {
      requireUserActor(context, permission);
      const productId = productIdOrNotFound(input.productId);
      const expectedVersion = parseExpectedVersion(input.expectedVersion);
      const reason =
        input.reason === undefined
          ? undefined
          : withDomainRules(() => parseCatalogChangeReason(input.reason as string), "reason");
      return dependencies.unitOfWork.run(async (scope) => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        const item = await dependencies.products.findByIdForUpdate(scope, context.businessId, productId);
        if (item === undefined) throw new NotFoundError(PRODUCT_NOT_FOUND);
        const transition = withDomainRules(() =>
          archiveProduct({ item, expectedVersion, now: dependencies.clock.now() }),
        );
        if (transition.outcome === "unchanged") return { item, changed: false };
        await dependencies.products.update(scope, item, transition.item);
        await dependencies.audit.recordBusinessEvent(scope, productArchived, {
          ...businessAuditEnvelope(context),
          entityId: item.product.id,
          ...(reason === undefined ? {} : { reason }),
          payload: { variantId: item.variant.id },
        });
        return { item: transition.item, changed: true };
      });
    },
  };
}

export function createReactivateProduct(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly products: ProductRepository;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
}): ReactivateProduct {
  const permission = catalogPermissions.permissions["product:manage"];
  return {
    async execute(context, input) {
      requireUserActor(context, permission);
      const productId = productIdOrNotFound(input.productId);
      const expectedVersion = parseExpectedVersion(input.expectedVersion);
      return dependencies.unitOfWork.run(async (scope) => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        const item = await dependencies.products.findByIdForUpdate(scope, context.businessId, productId);
        if (item === undefined) throw new NotFoundError(PRODUCT_NOT_FOUND);
        const transition = withDomainRules(() =>
          reactivateProduct({ item, expectedVersion, now: dependencies.clock.now() }),
        );
        if (transition.outcome === "unchanged") return { item, changed: false };
        if (item.variant.barcode !== undefined) {
          await requireBarcodeAvailable(
            scope,
            dependencies.products,
            context.businessId,
            item.variant.barcode,
            item.variant.id,
          );
        }
        await dependencies.products.update(scope, item, transition.item);
        await dependencies.audit.recordBusinessEvent(scope, productReactivated, {
          ...businessAuditEnvelope(context),
          entityId: item.product.id,
          payload: { variantId: item.variant.id },
        });
        return { item: transition.item, changed: true };
      });
    },
  };
}
