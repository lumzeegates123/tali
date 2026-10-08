import type {
  BusinessId,
  CatalogProduct,
  MembershipId,
  ProductCategory,
  ProductPack,
  ProductVariantId,
  ProductVariantPrice,
  UnitDefinition,
  VariantInventoryState,
} from "@tali/domain";
import { INITIAL_UNITS_OF_MEASURE } from "@tali/domain";
import { ConcurrentModificationError, ConflictError } from "../errors/application-error.js";
import type {
  ProductCategoryRepository,
  ProductPackRepository,
  ProductPriceHistoryRepository,
  ProductRepository,
  UnitReferenceRepository,
  VariantInventoryStateReader,
} from "../modules/catalog/index.js";
import {
  assertCatalogProductTransition,
  assertCategoryTransition,
  assertPackTransition,
} from "../modules/catalog/index.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import { FailureInjection } from "./failure-injection.js";
import type { InMemoryTenancyStore } from "./in-memory-tenancy-store.js";
import { page } from "./in-memory-tenancy-store.js";
import type { InMemoryUnitOfWork, RollbackParticipant } from "./in-memory-unit-of-work.js";

const NO_INVENTORY: VariantInventoryState = Object.freeze({
  hasMovements: false,
  hasNonZeroBalance: false,
  hasConfiguredThreshold: false,
});

/**
 * In-memory products, variants, categories, packs, price history and unit
 * reference data, implementing the Build 2 Slice 1 catalog ports. It enforces
 * the uniqueness, version and ownership constraints the Slice 2 schema will
 * enforce, so use case tests fail on the same mistakes. It proves nothing
 * about database-level tenant isolation.
 *
 * Inventory state is test input only (`setInventoryState`): Slice 1 has no
 * inventory, and this fake is not an inventory implementation.
 */
export class InMemoryCatalogStore implements RollbackParticipant {
  readonly failures = new FailureInjection();
  readonly #unitOfWork: InMemoryUnitOfWork | undefined;
  readonly #tenancy: InMemoryTenancyStore | undefined;
  #products = new Map<string, CatalogProduct>();
  #categories = new Map<string, ProductCategory>();
  #packs = new Map<string, ProductPack>();
  #prices: ProductVariantPrice[] = [];
  readonly #units = new Map<string, UnitDefinition>();
  readonly #inventory = new Map<string, VariantInventoryState>();

  constructor(
    options: {
      readonly unitOfWork?: InMemoryUnitOfWork;
      readonly tenancy?: InMemoryTenancyStore;
      readonly units?: readonly UnitDefinition[];
    } = {},
  ) {
    this.#unitOfWork = options.unitOfWork;
    this.#tenancy = options.tenancy;
    for (const unit of options.units ?? INITIAL_UNITS_OF_MEASURE) this.#units.set(unit.code, unit);
    this.#unitOfWork?.enlist(this);
  }

  captureState(): () => void {
    const products = new Map(this.#products);
    const categories = new Map(this.#categories);
    const packs = new Map(this.#packs);
    const prices = [...this.#prices];
    return () => {
      this.#products = products;
      this.#categories = categories;
      this.#packs = packs;
      this.#prices = prices;
    };
  }

  // Test setup.

  /** What the (future) inventory module would report for a variant. Defaults to no movements and zero balance. */
  /** Facts not given default to false (no movements, zero balance, no configured threshold). */
  setInventoryState(variantId: ProductVariantId, state: Partial<VariantInventoryState>): this {
    this.#inventory.set(variantId, Object.freeze({ ...NO_INVENTORY, ...state }));
    return this;
  }

  /** Replaces a stored product as another request would, bypassing use cases. */
  putProduct(item: CatalogProduct): this {
    this.#products.set(item.product.id, item);
    return this;
  }

  // Inspection.

  get products(): readonly CatalogProduct[] {
    return [...this.#products.values()];
  }

  get categories(): readonly ProductCategory[] {
    return [...this.#categories.values()];
  }

  get packs(): readonly ProductPack[] {
    return [...this.#packs.values()];
  }

  get priceHistory(): readonly ProductVariantPrice[] {
    return [...this.#prices];
  }

  #enter(scope: TransactionScope, operation: string): void {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check(operation);
  }

  #requireMemberOf(businessId: BusinessId, membershipId: MembershipId): void {
    if (this.#tenancy === undefined) return;
    const member = this.#tenancy.memberships.find((candidate) => candidate.id === membershipId);
    if (member?.businessId !== businessId) throw new Error("membership does not belong to the record's business");
  }

  #variants(): readonly CatalogProduct["variant"][] {
    return [...this.#products.values()].map((item) => item.variant);
  }

  #checkProductConstraints(item: CatalogProduct): void {
    const { product, variant } = item;
    if (variant.businessId !== product.businessId || variant.productId !== product.id || !variant.isDefault) {
      throw new Error("a product's default variant must belong to it");
    }
    if (variant.status !== product.status) throw new Error("variant status must equal product status");
    if (!this.#units.has(variant.stockUnit)) throw new Error("stock unit must reference units_of_measure");
    if (product.categoryId !== undefined) {
      const category = this.#categories.get(product.categoryId);
      if (category?.businessId !== product.businessId) throw new Error("category must belong to the same business");
    }
    for (const other of this.#variants()) {
      if (other.id === variant.id || other.businessId !== variant.businessId) continue;
      if (variant.sku !== undefined && other.sku?.normalized === variant.sku.normalized) {
        throw new ConflictError("unique violation: product_variants (business_id, sku_normalized)");
      }
      if (
        variant.barcode !== undefined &&
        variant.status === "ACTIVE" &&
        other.status === "ACTIVE" &&
        other.barcode?.normalized === variant.barcode.normalized
      ) {
        throw new ConflictError("unique violation: product_variants (business_id, barcode_normalized) WHERE ACTIVE");
      }
    }
  }

  readonly productRepository: ProductRepository = {
    insert: async (scope, item) => {
      this.#enter(scope, "products.insert");
      if (this.#products.has(item.product.id)) throw new Error("duplicate product id");
      if (this.#variants().some((variant) => variant.id === item.variant.id)) throw new Error("duplicate variant id");
      this.#requireMemberOf(item.product.businessId, item.product.createdByMembershipId);
      this.#checkProductConstraints(item);
      this.#products.set(item.product.id, item);
    },
    findByIdForUpdate: async (scope, businessId, productId) => {
      this.#enter(scope, "products.findByIdForUpdate");
      const item = this.#products.get(productId);
      return item?.product.businessId === businessId ? item : undefined;
    },
    findById: async (scope, businessId, productId) => {
      this.#enter(scope, "products.findById");
      const item = this.#products.get(productId);
      return item?.product.businessId === businessId ? item : undefined;
    },
    list: async (scope, businessId, query, request) => {
      this.#enter(scope, "products.list");
      const search = query.search;
      const needle = search?.nameContains.toLowerCase();
      const matches = [...this.#products.values()].filter(({ product, variant }) => {
        if (product.businessId !== businessId || product.status !== query.status) return false;
        if (search === undefined || needle === undefined) return true;
        return (
          product.name.toLowerCase().includes(needle) ||
          (search.skuKey !== undefined && variant.sku?.normalized === search.skuKey) ||
          (search.barcodeKey !== undefined && variant.barcode?.normalized === search.barcodeKey)
        );
      });
      return page(matches, (item) => item.product.id, request);
    },
    update: async (scope, previous, next) => {
      this.#enter(scope, "products.update");
      assertCatalogProductTransition(previous, next);
      const stored = this.#products.get(previous.product.id);
      if (
        stored?.product.businessId !== previous.product.businessId ||
        stored.product.version !== previous.product.version
      ) {
        throw new ConcurrentModificationError();
      }
      this.#checkProductConstraints(next);
      this.#products.set(next.product.id, next);
    },
    findVariantIdBySku: async (scope, businessId, sku) => {
      this.#enter(scope, "products.findVariantIdBySku");
      return this.#variants().find((v) => v.businessId === businessId && v.sku?.normalized === sku)?.id;
    },
    findActiveVariantIdByBarcode: async (scope, businessId, barcode) => {
      this.#enter(scope, "products.findActiveVariantIdByBarcode");
      return this.#variants().find(
        (v) => v.businessId === businessId && v.status === "ACTIVE" && v.barcode?.normalized === barcode,
      )?.id;
    },
    lockVariantsForShare: async (scope, businessId, variantIds) => {
      this.#enter(scope, "products.lockVariantsForShare");
      const locked = this.#variants()
        .filter((v) => v.businessId === businessId && variantIds.has(v.id))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return new Map(locked.map((variant) => [variant.id, variant]));
    },
  };

  readonly priceHistoryRepository: ProductPriceHistoryRepository = {
    append: async (scope, entry) => {
      this.#enter(scope, "prices.append");
      const owner = this.#variants().find((v) => v.id === entry.variantId);
      if (owner?.businessId !== entry.businessId)
        throw new Error("price history must reference a variant of its business");
      if (owner.sellingPrice?.currency !== entry.price.currency)
        throw new Error("price currency must match the variant's");
      this.#requireMemberOf(entry.businessId, entry.setByMembershipId);
      if (
        this.#prices.some(
          (row) =>
            row.businessId === entry.businessId &&
            row.variantId === entry.variantId &&
            row.priceVersion === entry.priceVersion,
        )
      ) {
        throw new ConflictError("unique violation: product_variant_prices (business_id, variant_id, price_version)");
      }
      this.#prices.push(entry);
    },
    listForVariant: async (scope, businessId, variantId, request) => {
      this.#enter(scope, "prices.listForVariant");
      const rows = this.#prices.filter((row) => row.businessId === businessId && row.variantId === variantId);
      return page(rows, (row) => row.id, request);
    },
  };

  readonly categoryRepository: ProductCategoryRepository = {
    insert: async (scope, category) => {
      this.#enter(scope, "categories.insert");
      if (this.#categories.has(category.id)) throw new Error("duplicate category id");
      this.#checkCategoryName(category);
      this.#categories.set(category.id, category);
    },
    findByIdForUpdate: async (scope, businessId, categoryId) => {
      this.#enter(scope, "categories.findByIdForUpdate");
      const category = this.#categories.get(categoryId);
      return category?.businessId === businessId ? category : undefined;
    },
    findById: async (scope, businessId, categoryId) => {
      this.#enter(scope, "categories.findById");
      const category = this.#categories.get(categoryId);
      return category?.businessId === businessId ? category : undefined;
    },
    list: async (scope, businessId, status, request) => {
      this.#enter(scope, "categories.list");
      const rows = [...this.#categories.values()].filter((c) => c.businessId === businessId && c.status === status);
      return page(rows, (c) => c.id, request);
    },
    update: async (scope, previous, next) => {
      this.#enter(scope, "categories.update");
      assertCategoryTransition(previous, next);
      const stored = this.#categories.get(previous.id);
      if (stored?.businessId !== previous.businessId || stored.version !== previous.version) {
        throw new ConcurrentModificationError();
      }
      this.#checkCategoryName(next);
      this.#categories.set(next.id, next);
    },
    findActiveIdByName: async (scope, businessId, name) => {
      this.#enter(scope, "categories.findActiveIdByName");
      return [...this.#categories.values()].find(
        (c) => c.businessId === businessId && c.status === "ACTIVE" && c.normalizedName === name,
      )?.id;
    },
  };

  #checkCategoryName(category: ProductCategory): void {
    if (category.status !== "ACTIVE") return;
    for (const other of this.#categories.values()) {
      if (
        other.id !== category.id &&
        other.businessId === category.businessId &&
        other.status === "ACTIVE" &&
        other.normalizedName === category.normalizedName
      ) {
        throw new ConflictError("unique violation: product_categories (business_id, normalized name) WHERE ACTIVE");
      }
    }
  }

  readonly packRepository: ProductPackRepository = {
    insert: async (scope, pack) => {
      this.#enter(scope, "packs.insert");
      if (this.#packs.has(pack.id)) throw new Error("duplicate pack id");
      const owner = this.#variants().find((v) => v.id === pack.variantId);
      if (owner?.businessId !== pack.businessId) throw new Error("a pack must reference a variant of its business");
      for (const other of this.#packs.values()) {
        if (other.businessId === pack.businessId && other.variantId === pack.variantId && other.status === "ACTIVE") {
          if (other.name === pack.name) {
            throw new ConflictError("unique violation: product_packs (business_id, variant_id, name) WHERE ACTIVE");
          }
        }
      }
      this.#packs.set(pack.id, pack);
    },
    findByIdForUpdate: async (scope, businessId, packId) => {
      this.#enter(scope, "packs.findByIdForUpdate");
      const pack = this.#packs.get(packId);
      return pack?.businessId === businessId ? pack : undefined;
    },
    update: async (scope, previous, next) => {
      this.#enter(scope, "packs.update");
      assertPackTransition(previous, next);
      const stored = this.#packs.get(previous.id);
      if (stored?.businessId !== previous.businessId || stored.status !== previous.status) {
        throw new ConcurrentModificationError();
      }
      this.#packs.set(next.id, next);
    },
    listForVariant: async (scope, businessId, variantId, status, request) => {
      this.#enter(scope, "packs.listForVariant");
      const rows = [...this.#packs.values()].filter(
        (p) => p.businessId === businessId && p.variantId === variantId && p.status === status,
      );
      return page(rows, (p) => p.id, request);
    },
    hasActivePacks: async (scope, businessId, variantId) => {
      this.#enter(scope, "packs.hasActivePacks");
      return [...this.#packs.values()].some(
        (p) => p.businessId === businessId && p.variantId === variantId && p.status === "ACTIVE",
      );
    },
    findActiveIdByName: async (scope, businessId, variantId, name) => {
      this.#enter(scope, "packs.findActiveIdByName");
      return [...this.#packs.values()].find(
        (p) => p.businessId === businessId && p.variantId === variantId && p.status === "ACTIVE" && p.name === name,
      )?.id;
    },
    findForEntry: async (scope, businessId, packIds) => {
      this.#enter(scope, "packs.findForEntry");
      const found = [...this.#packs.values()].filter((p) => p.businessId === businessId && packIds.has(p.id));
      return new Map(found.map((pack) => [pack.id, pack]));
    },
  };

  readonly unitRepository: UnitReferenceRepository = {
    findByCode: async (scope, code) => {
      this.#enter(scope, "units.findByCode");
      return this.#units.get(code);
    },
    listAll: async (scope) => {
      this.#enter(scope, "units.listAll");
      return [...this.#units.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    },
  };

  readonly inventoryStateReader: VariantInventoryStateReader = {
    stateOf: async (scope, businessId, variantId) => {
      this.#enter(scope, "inventory.stateOf");
      const owner = this.#variants().find((v) => v.id === variantId);
      if (owner?.businessId !== businessId) throw new Error("inventory state asked for a foreign variant");
      return this.#inventory.get(variantId) ?? NO_INVENTORY;
    },
  };
}
