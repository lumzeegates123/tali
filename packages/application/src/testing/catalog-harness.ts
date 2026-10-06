import type { CurrencyDefinition, MembershipRole } from "@tali/domain";
import { AuditRecorder } from "../audit/audit-recorder.js";
import { taliAuditRegistry } from "../audit/tali-audit-registry.js";
import type { BusinessContext } from "../context/business-context.js";
import { KeyedIdempotency } from "../idempotency/keyed-idempotency.js";
import type {
  AddPack,
  ArchiveCategory,
  ArchiveProduct,
  CreateCategory,
  CreateProduct,
  GetCategory,
  GetProduct,
  ListCategories,
  ListProductPacks,
  ListProductPriceHistory,
  ListProducts,
  ListUnitsOfMeasure,
  ReactivateProduct,
  RetirePack,
  SetSellingPrice,
  UpdateCategory,
  UpdateProduct,
} from "../modules/catalog/index.js";
import {
  createAddPack,
  createArchiveCategory,
  createArchiveProduct,
  createCreateCategory,
  createCreateProduct,
  createGetCategory,
  createGetProduct,
  createListCategories,
  createListProductPacks,
  createListProductPriceHistory,
  createListProducts,
  createListUnitsOfMeasure,
  createReactivateProduct,
  createRetirePack,
  createSetSellingPrice,
  createUpdateCategory,
  createUpdateProduct,
} from "../modules/catalog/index.js";
import { InMemoryCatalogStore } from "./in-memory-catalog-store.js";
import type { TenancyHarness } from "./tenancy-harness.js";
import { createTenancyHarness } from "./tenancy-harness.js";

/** Every catalog mutation (Slice 1) and read (Slice 3) use case composed over the tenancy harness's fakes. */
export interface CatalogHarness {
  readonly tenancy: TenancyHarness;
  readonly catalog: InMemoryCatalogStore;
  readonly createProduct: CreateProduct;
  readonly updateProduct: UpdateProduct;
  readonly archiveProduct: ArchiveProduct;
  readonly reactivateProduct: ReactivateProduct;
  readonly setSellingPrice: SetSellingPrice;
  readonly createCategory: CreateCategory;
  readonly updateCategory: UpdateCategory;
  readonly archiveCategory: ArchiveCategory;
  readonly addPack: AddPack;
  readonly retirePack: RetirePack;
  readonly getProduct: GetProduct;
  readonly listProducts: ListProducts;
  readonly getCategory: GetCategory;
  readonly listCategories: ListCategories;
  readonly listProductPacks: ListProductPacks;
  readonly listProductPriceHistory: ListProductPriceHistory;
  readonly listUnitsOfMeasure: ListUnitsOfMeasure;
  /** A business in `currencyCode` with one ACTIVE member per role, and the resolved context of each. */
  businessWithRoles(name: string, currencyCode?: string): Promise<Readonly<Record<MembershipRole, BusinessContext>>>;
}

export function createCatalogHarness(options: {
  readonly currencies: readonly CurrencyDefinition[];
  readonly start?: string;
}): CatalogHarness {
  const tenancy = createTenancyHarness(options);
  const { unitOfWork, clock, ids, hasher } = tenancy;
  const catalog = new InMemoryCatalogStore({ unitOfWork, tenancy: tenancy.store });
  const audit = new AuditRecorder({ registry: taliAuditRegistry, writer: tenancy.auditWriter, clock, ids });
  const idempotency = new KeyedIdempotency({ businessStore: tenancy.businessIdempotencyStore, clock, ids });
  const memberships = tenancy.store.membershipRepository;
  const products = catalog.productRepository;
  const categories = catalog.categoryRepository;
  const packs = catalog.packRepository;
  const prices = catalog.priceHistoryRepository;
  const units = catalog.unitRepository;
  let sequence = 0;

  return {
    tenancy,
    catalog,
    createProduct: createCreateProduct({
      unitOfWork,
      memberships,
      products,
      categories,
      prices,
      units,
      idempotency,
      hasher,
      audit,
      ids,
      clock,
    }),
    updateProduct: createUpdateProduct({
      unitOfWork,
      memberships,
      products,
      categories,
      packs,
      units,
      inventory: catalog.inventoryStateReader,
      audit,
      clock,
    }),
    archiveProduct: createArchiveProduct({ unitOfWork, memberships, products, audit, clock }),
    reactivateProduct: createReactivateProduct({ unitOfWork, memberships, products, audit, clock }),
    setSellingPrice: createSetSellingPrice({ unitOfWork, memberships, products, prices, audit, ids, clock }),
    createCategory: createCreateCategory({
      unitOfWork,
      memberships,
      categories,
      idempotency,
      hasher,
      audit,
      ids,
      clock,
    }),
    updateCategory: createUpdateCategory({ unitOfWork, memberships, categories, audit, clock }),
    archiveCategory: createArchiveCategory({ unitOfWork, memberships, categories, audit, clock }),
    addPack: createAddPack({ unitOfWork, memberships, products, packs, idempotency, hasher, audit, ids, clock }),
    retirePack: createRetirePack({ unitOfWork, memberships, packs, audit, clock }),
    getProduct: createGetProduct({ unitOfWork, products }),
    listProducts: createListProducts({ unitOfWork, products }),
    getCategory: createGetCategory({ unitOfWork, categories }),
    listCategories: createListCategories({ unitOfWork, categories }),
    listProductPacks: createListProductPacks({ unitOfWork, products, packs }),
    listProductPriceHistory: createListProductPriceHistory({ unitOfWork, products, prices }),
    listUnitsOfMeasure: createListUnitsOfMeasure({ unitOfWork, units }),
    async businessWithRoles(name, currencyCode) {
      sequence += 1;
      const owner = await tenancy.registeredUser(`${name}-owner-${sequence}`);
      const created = await tenancy.businessOwnedBy(owner, {
        name,
        ...(currencyCode === undefined ? {} : { currencyCode }),
      });
      const businessId = created.business.id;
      const contexts: Partial<Record<MembershipRole, BusinessContext>> = {
        OWNER: await tenancy.businessContexts.resolveForUser(owner.context, businessId),
      };
      for (const role of ["MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"] as const) {
        const user = await tenancy.registeredUser(`${name}-${role.toLowerCase()}-${sequence}`);
        tenancy.addMember(businessId, user, role);
        contexts[role] = await tenancy.businessContexts.resolveForUser(user.context, businessId);
      }
      return contexts as Readonly<Record<MembershipRole, BusinessContext>>;
    },
  };
}
