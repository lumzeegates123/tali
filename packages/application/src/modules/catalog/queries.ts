import type {
  CatalogProduct,
  CatalogStatus,
  PackStatus,
  ProductCategory,
  ProductPack,
  ProductVariantPrice,
  UnitDefinition,
} from "@tali/domain";
import { CATALOG_STATUSES, PACK_STATUSES, parseBarcode, parseSku } from "@tali/domain";
import type { BusinessContext } from "../../context/business-context.js";
import { requireContextPermission } from "../../context/business-context.js";
import { NotFoundError, ValidationError } from "../../errors/application-error.js";
import type { TransactionScope, UnitOfWork } from "../../ports/unit-of-work.js";
import type { Page } from "../../queries/pagination.js";
import { parsePageRequest } from "../../queries/pagination.js";
import { catalogPermissions } from "../identity/index.js";
import { CATEGORY_NOT_FOUND, categoryIdOrNotFound, PRODUCT_NOT_FOUND, productIdOrNotFound } from "./catalog-common.js";
import type {
  ProductCategoryRepository,
  ProductPackRepository,
  ProductPriceHistoryRepository,
  ProductRepository,
  ProductSearch,
  UnitReferenceRepository,
} from "./ports.js";

/** The longest accepted search term, in code points after trimming. */
export const PRODUCT_SEARCH_MAX_LENGTH = 120;

type PageInput = { readonly limit?: number; readonly after?: string };

/** `product:read`. One product of the context business, in any status. */
export interface GetProduct {
  execute(context: BusinessContext, input: { readonly productId: string }): Promise<CatalogProduct>;
}

/** `product:read`. Products in one status (ACTIVE by default), optionally searched by name, SKU or barcode. */
export interface ListProducts {
  execute(
    context: BusinessContext,
    input?: PageInput & { readonly status?: string; readonly q?: string },
  ): Promise<Page<CatalogProduct>>;
}

/** `product:read`. One category of the context business, in any status. */
export interface GetCategory {
  execute(context: BusinessContext, input: { readonly categoryId: string }): Promise<ProductCategory>;
}

/** `product:read`. Categories in one status (ACTIVE by default). */
export interface ListCategories {
  execute(context: BusinessContext, input?: PageInput & { readonly status?: string }): Promise<Page<ProductCategory>>;
}

/** `product:read`. A product's packs in one status (ACTIVE by default). */
export interface ListProductPacks {
  execute(
    context: BusinessContext,
    input: PageInput & { readonly productId: string; readonly status?: string },
  ): Promise<Page<ProductPack>>;
}

/** `product:read`. A product's selling-price history, oldest first. */
export interface ListProductPriceHistory {
  execute(
    context: BusinessContext,
    input: PageInput & { readonly productId: string },
  ): Promise<Page<ProductVariantPrice>>;
}

/** `product:read`. The approved units of measure (global reference data). */
export interface ListUnitsOfMeasure {
  execute(context: BusinessContext): Promise<readonly UnitDefinition[]>;
}

function invalid(field: string, message: string): ValidationError {
  return new ValidationError(message, [{ path: [field], message }]);
}

function pageOf(input: PageInput | undefined): PageInput {
  return {
    ...(input?.limit === undefined ? {} : { limit: input.limit }),
    ...(input?.after === undefined ? {} : { after: input.after }),
  };
}

function catalogStatus(value: string | undefined): CatalogStatus {
  if (value === undefined) return "ACTIVE";
  if (!(CATALOG_STATUSES as readonly string[]).includes(value)) {
    throw invalid("status", "status must be ACTIVE or ARCHIVED");
  }
  return value as CatalogStatus;
}

function packStatus(value: string | undefined): PackStatus {
  if (value === undefined) return "ACTIVE";
  if (!(PACK_STATUSES as readonly string[]).includes(value)) {
    throw invalid("status", "status must be ACTIVE or RETIRED");
  }
  return value as PackStatus;
}

const LONE_SURROGATE = /\p{Cs}/u;

function attempt<T>(parse: () => T): T | undefined {
  try {
    return parse();
  } catch {
    return undefined;
  }
}

/**
 * One search term matched three ways (ADR-008 section 3.1): name containment,
 * and the exact normalized SKU and barcode keys when the term is a valid SKU or
 * barcode. A term that is neither is still a valid name search.
 */
export function parseProductSearch(value: string): ProductSearch {
  if (typeof value !== "string" || LONE_SURROGATE.test(value)) {
    throw invalid("q", "q must be well-formed text");
  }
  const term = value.trim().normalize("NFC");
  const length = Array.from(term).length;
  if (length < 1 || length > PRODUCT_SEARCH_MAX_LENGTH) {
    throw invalid("q", `q must be 1 to ${PRODUCT_SEARCH_MAX_LENGTH} characters`);
  }
  const skuKey = attempt(() => parseSku(term).normalized);
  const barcodeKey = attempt(() => parseBarcode(term).normalized);
  return {
    nameContains: term,
    ...(skuKey === undefined ? {} : { skuKey }),
    ...(barcodeKey === undefined ? {} : { barcodeKey }),
  };
}

async function requireProduct(
  scope: TransactionScope,
  products: ProductRepository,
  context: BusinessContext,
  productId: string,
): Promise<CatalogProduct> {
  const id = productIdOrNotFound(productId);
  const found = await products.findById(scope, context.businessId, id);
  if (found === undefined) throw new NotFoundError(PRODUCT_NOT_FOUND);
  return found;
}

const read = catalogPermissions.permissions["product:read"];

export function createGetProduct(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
}): GetProduct {
  return {
    async execute(context, input) {
      requireContextPermission(context, read);
      return dependencies.unitOfWork.run((scope) =>
        requireProduct(scope, dependencies.products, context, input.productId),
      );
    },
  };
}

export function createListProducts(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
}): ListProducts {
  return {
    async execute(context, input) {
      requireContextPermission(context, read);
      const request = parsePageRequest(pageOf(input));
      const status = catalogStatus(input?.status);
      const search = input?.q === undefined ? undefined : parseProductSearch(input.q);
      return dependencies.unitOfWork.run((scope) =>
        dependencies.products.list(
          scope,
          context.businessId,
          { status, ...(search === undefined ? {} : { search }) },
          request,
        ),
      );
    },
  };
}

export function createGetCategory(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly categories: ProductCategoryRepository;
}): GetCategory {
  return {
    async execute(context, input) {
      requireContextPermission(context, read);
      const id = categoryIdOrNotFound(input.categoryId);
      const found = await dependencies.unitOfWork.run((scope) =>
        dependencies.categories.findById(scope, context.businessId, id),
      );
      if (found === undefined) throw new NotFoundError(CATEGORY_NOT_FOUND);
      return found;
    },
  };
}

export function createListCategories(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly categories: ProductCategoryRepository;
}): ListCategories {
  return {
    async execute(context, input) {
      requireContextPermission(context, read);
      const request = parsePageRequest(pageOf(input));
      const status = catalogStatus(input?.status);
      return dependencies.unitOfWork.run((scope) =>
        dependencies.categories.list(scope, context.businessId, status, request),
      );
    },
  };
}

export function createListProductPacks(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly packs: ProductPackRepository;
}): ListProductPacks {
  return {
    async execute(context, input) {
      requireContextPermission(context, read);
      const request = parsePageRequest(pageOf(input));
      const status = packStatus(input.status);
      return dependencies.unitOfWork.run(async (scope) => {
        const { variant } = await requireProduct(scope, dependencies.products, context, input.productId);
        return dependencies.packs.listForVariant(scope, context.businessId, variant.id, status, request);
      });
    },
  };
}

export function createListProductPriceHistory(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly prices: ProductPriceHistoryRepository;
}): ListProductPriceHistory {
  return {
    async execute(context, input) {
      requireContextPermission(context, read);
      const request = parsePageRequest(pageOf(input));
      return dependencies.unitOfWork.run(async (scope) => {
        const { variant } = await requireProduct(scope, dependencies.products, context, input.productId);
        return dependencies.prices.listForVariant(scope, context.businessId, variant.id, request);
      });
    },
  };
}

export function createListUnitsOfMeasure(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly units: UnitReferenceRepository;
}): ListUnitsOfMeasure {
  return {
    async execute(context) {
      requireContextPermission(context, read);
      return dependencies.unitOfWork.run((scope) => dependencies.units.listAll(scope));
    },
  };
}
