import {
  type AcceptInvitation,
  type AddPack,
  type ArchiveCategory,
  type ArchiveProduct,
  AuditRecorder,
  type BusinessContextResolver,
  type CancelStocktake,
  type ChangeMemberRole,
  type ClearLowStockThreshold,
  type Clock,
  type CreateBusiness,
  type CreateCategory,
  type CreateInvitation,
  type CreateProduct,
  type CreateStocktake,
  createAcceptInvitation,
  createAddPack,
  createArchiveCategory,
  createArchiveProduct,
  createBusinessContextResolver,
  createCancelStocktake,
  createChangeMemberRole,
  createClearLowStockThreshold,
  createCreateBusiness,
  createCreateCategory,
  createCreateInvitation,
  createCreateProduct,
  createCreateStocktake,
  createDefaultLocationCreation,
  createDefaultLocationResolver,
  createDeviceVerifier,
  createGetAdjustment,
  createGetBusiness,
  createGetBusinessCurrency,
  createGetCategory,
  createGetCurrentUser,
  createGetGoodsReceipt,
  createGetInventoryItem,
  createGetOpeningBatch,
  createGetProduct,
  createGetStocktake,
  createListCategories,
  createListDevices,
  createListInventoryItems,
  createListItemMovements,
  createListLocations,
  createListMembers,
  createListMyBusinesses,
  createListProductPacks,
  createListProductPriceHistory,
  createListProducts,
  createListStocktakeLines,
  createListStocktakes,
  createListUnitsOfMeasure,
  createPostGoodsReceipt,
  createPostStocktake,
  createReactivateMember,
  createReactivateProduct,
  createRecordAdjustment,
  createRecordOpeningStock,
  createRecordStocktakeCount,
  createRecordWriteOff,
  createRegisterCurrentUser,
  createRegisterDevice,
  createRemoveStocktakeLine,
  createRetirePack,
  createReverseAdjustment,
  createReverseGoodsReceipt,
  createRevokeDevice,
  createRevokeInvitation,
  createSetLowStockThreshold,
  createSetSellingPrice,
  createSuspendMember,
  createUpdateBusinessName,
  createUpdateCategory,
  createUpdateProduct,
  createUserContextResolver,
  type DefaultLocationResolver,
  type DeviceVerifier,
  type FingerprintHasher,
  type GetAdjustment,
  type GetBusiness,
  type GetBusinessCurrency,
  type GetCategory,
  type GetCurrentUser,
  type GetGoodsReceipt,
  type GetInventoryItem,
  type GetOpeningBatch,
  type GetProduct,
  type GetStocktake,
  type IdGenerator,
  KeyedIdempotency,
  type ListCategories,
  type ListDevices,
  type ListInventoryItems,
  type ListItemMovements,
  type ListLocations,
  type ListMembers,
  type ListMyBusinesses,
  type ListProductPacks,
  type ListProductPriceHistory,
  type ListProducts,
  type ListStocktakeLines,
  type ListStocktakes,
  type ListUnitsOfMeasure,
  type OneTimeSecretGenerator,
  type PostGoodsReceipt,
  type PostStocktake,
  type ReactivateMember,
  type ReactivateProduct,
  type RecordAdjustment,
  type RecordOpeningStock,
  type RecordStocktakeCount,
  type RecordWriteOff,
  type RegisterCurrentUser,
  type RegisterDevice,
  type RemoveStocktakeLine,
  type RetirePack,
  type ReverseAdjustment,
  type ReverseGoodsReceipt,
  type RevokeDevice,
  type RevokeInvitation,
  type SecretHasher,
  type SetLowStockThreshold,
  type SetSellingPrice,
  type SuspendMember,
  taliAuditRegistry,
  type UpdateBusinessName,
  type UpdateCategory,
  type UpdateProduct,
  type UserContextResolver,
} from "@tali/application";
import type { Database } from "@tali/database";
/**
 * The application-facing services the HTTP layer may call: context resolvers,
 * the device verifier and use cases only. Guards and controllers receive this
 * object; they never see repositories, the unit of work or the Prisma client.
 */
export interface ApiServices {
  readonly userContexts: UserContextResolver;
  readonly businessContexts: BusinessContextResolver;
  readonly deviceVerifier: DeviceVerifier;
  readonly defaultLocations: DefaultLocationResolver;
  readonly registerCurrentUser: RegisterCurrentUser;
  readonly getCurrentUser: GetCurrentUser;
  readonly createBusiness: CreateBusiness;
  readonly listMyBusinesses: ListMyBusinesses;
  readonly getBusiness: GetBusiness;
  readonly getBusinessCurrency: GetBusinessCurrency;
  readonly listLocations: ListLocations;
  readonly listMembers: ListMembers;
  readonly updateBusinessName: UpdateBusinessName;
  readonly changeMemberRole: ChangeMemberRole;
  readonly suspendMember: SuspendMember;
  readonly reactivateMember: ReactivateMember;
  readonly createInvitation: CreateInvitation;
  readonly revokeInvitation: RevokeInvitation;
  readonly acceptInvitation: AcceptInvitation;
  readonly registerDevice: RegisterDevice;
  readonly listDevices: ListDevices;
  readonly revokeDevice: RevokeDevice;
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
  readonly recordOpeningStock: RecordOpeningStock;
  readonly postGoodsReceipt: PostGoodsReceipt;
  readonly recordAdjustment: RecordAdjustment;
  readonly recordWriteOff: RecordWriteOff;
  readonly reverseGoodsReceipt: ReverseGoodsReceipt;
  readonly reverseAdjustment: ReverseAdjustment;
  readonly setLowStockThreshold: SetLowStockThreshold;
  readonly clearLowStockThreshold: ClearLowStockThreshold;
  readonly createStocktake: CreateStocktake;
  readonly recordStocktakeCount: RecordStocktakeCount;
  readonly removeStocktakeLine: RemoveStocktakeLine;
  readonly postStocktake: PostStocktake;
  readonly cancelStocktake: CancelStocktake;
  readonly listInventoryItems: ListInventoryItems;
  readonly getInventoryItem: GetInventoryItem;
  readonly listItemMovements: ListItemMovements;
  readonly getOpeningBatch: GetOpeningBatch;
  readonly getGoodsReceipt: GetGoodsReceipt;
  readonly getAdjustment: GetAdjustment;
  readonly listStocktakes: ListStocktakes;
  readonly getStocktake: GetStocktake;
  readonly listStocktakeLines: ListStocktakeLines;
}

/** The ApiServices keys of the Build 2 inventory and stocktake use cases, in route order. */
export const INVENTORY_SERVICE_KEYS = [
  "recordOpeningStock",
  "postGoodsReceipt",
  "recordAdjustment",
  "recordWriteOff",
  "reverseGoodsReceipt",
  "reverseAdjustment",
  "setLowStockThreshold",
  "clearLowStockThreshold",
  "createStocktake",
  "recordStocktakeCount",
  "removeStocktakeLine",
  "postStocktake",
  "cancelStocktake",
  "listInventoryItems",
  "getInventoryItem",
  "listItemMovements",
  "getOpeningBatch",
  "getGoodsReceipt",
  "getAdjustment",
  "listStocktakes",
  "getStocktake",
  "listStocktakeLines",
] as const satisfies readonly (keyof ApiServices)[];

/**
 * Composes the Build 1 and Build 2 catalog use cases over the PostgreSQL adapters: one unit of
 * work, the PostgreSQL audit writer and idempotency stores, the SHA-256
 * fingerprint hasher, the UUIDv7 generator and the node:crypto one-time
 * secret adapters. Transaction semantics are exactly those of the unit of
 * work; nothing here opens transactions. UpdateProduct's inventory guard
 * reads the authoritative inventory tables through the database's
 * variantInventoryState reader (movements, balances and configured low-stock
 * thresholds at every location).
 *
 * The Slice 5 stock documents, reversals and thresholds, the Slice 6
 * stocktakes and every stock read use the database's own inventory
 * repositories and readers under the same unit of work, the business-scoped
 * keyed idempotency, the fingerprint hasher, the audit recorder, the clock
 * and the ID generator. Controllers bind each request to the business's
 * default location before calling them.
 */
export function composeApiServices(dependencies: {
  readonly database: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly hasher: FingerprintHasher;
  readonly secrets: OneTimeSecretGenerator;
  readonly secretHasher: SecretHasher;
}): ApiServices {
  const { database, clock, ids, hasher, secrets, secretHasher } = dependencies;
  const { unitOfWork } = database;
  const {
    users,
    businesses,
    memberships,
    locations,
    currencies,
    invitations,
    devices,
    auditWriter,
    userIdempotency,
    businessIdempotency,
    products,
    productCategories: categories,
    productPacks: packs,
    productPriceHistory: prices,
    units,
  } = database.repositories;
  const audit = new AuditRecorder({ registry: taliAuditRegistry, writer: auditWriter, clock, ids });
  const userContexts = createUserContextResolver({ unitOfWork, users });
  const businessScoped = new KeyedIdempotency({ businessStore: businessIdempotency, clock, ids });
  const repos = database.repositories;
  const stock = {
    unitOfWork,
    memberships,
    products,
    packs,
    units,
    movements: repos.inventoryMovements,
    balances: repos.inventoryBalances,
    idempotency: businessScoped,
    hasher,
    audit,
    ids,
    clock,
  };
  const stocktaking = { ...stock, stocktakes: repos.stocktakes, stocktakeLines: repos.stocktakeLines };
  const stocktakeQueries = { unitOfWork, stocktakes: repos.stocktakes, stocktakeLines: repos.stocktakeLines };
  const stockReads = {
    unitOfWork,
    items: repos.inventoryItems,
    movements: repos.inventoryMovements,
    openings: repos.inventoryOpeningBatches,
    receipts: repos.goodsReceipts,
    adjustments: repos.inventoryAdjustments,
  };

  return Object.freeze({
    userContexts,
    businessContexts: createBusinessContextResolver({ unitOfWork, userContexts, businesses, memberships }),
    deviceVerifier: createDeviceVerifier({ unitOfWork, devices, secretHasher }),
    defaultLocations: createDefaultLocationResolver({ unitOfWork, locations }),
    registerCurrentUser: createRegisterCurrentUser({ unitOfWork, users, audit, ids, clock }),
    getCurrentUser: createGetCurrentUser({ unitOfWork, users }),
    createBusiness: createCreateBusiness({
      unitOfWork,
      users,
      businesses,
      memberships,
      currencies,
      defaultLocation: createDefaultLocationCreation({ locations, audit, ids }),
      idempotency: new KeyedIdempotency({ store: userIdempotency, clock, ids }),
      hasher,
      audit,
      ids,
      clock,
    }),
    listMyBusinesses: createListMyBusinesses({ unitOfWork, users, memberships }),
    getBusiness: createGetBusiness({ unitOfWork, businesses }),
    getBusinessCurrency: createGetBusinessCurrency({ unitOfWork, businesses, currencies }),
    listLocations: createListLocations({ unitOfWork, locations }),
    listMembers: createListMembers({ unitOfWork, memberships }),
    updateBusinessName: createUpdateBusinessName({ unitOfWork, businesses, memberships, audit, clock }),
    changeMemberRole: createChangeMemberRole({ unitOfWork, businesses, memberships, audit, clock }),
    suspendMember: createSuspendMember({ unitOfWork, businesses, memberships, audit, clock }),
    reactivateMember: createReactivateMember({ unitOfWork, businesses, memberships, audit, clock }),
    createInvitation: createCreateInvitation({
      unitOfWork,
      memberships,
      invitations,
      idempotency: businessScoped,
      hasher,
      secrets,
      secretHasher,
      audit,
      ids,
      clock,
    }),
    revokeInvitation: createRevokeInvitation({ unitOfWork, memberships, invitations, audit, clock }),
    acceptInvitation: createAcceptInvitation({
      unitOfWork,
      users,
      businesses,
      memberships,
      invitations,
      secretHasher,
      audit,
      ids,
      clock,
    }),
    registerDevice: createRegisterDevice({
      unitOfWork,
      memberships,
      devices,
      idempotency: businessScoped,
      hasher,
      secrets,
      secretHasher,
      audit,
      ids,
      clock,
    }),
    listDevices: createListDevices({ unitOfWork, devices }),
    revokeDevice: createRevokeDevice({ unitOfWork, memberships, devices, audit, clock }),
    createProduct: createCreateProduct({
      unitOfWork,
      memberships,
      products,
      categories,
      prices,
      units,
      idempotency: businessScoped,
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
      inventory: database.repositories.variantInventoryState,
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
      idempotency: businessScoped,
      hasher,
      audit,
      ids,
      clock,
    }),
    updateCategory: createUpdateCategory({ unitOfWork, memberships, categories, audit, clock }),
    archiveCategory: createArchiveCategory({ unitOfWork, memberships, categories, audit, clock }),
    addPack: createAddPack({
      unitOfWork,
      memberships,
      products,
      packs,
      idempotency: businessScoped,
      hasher,
      audit,
      ids,
      clock,
    }),
    retirePack: createRetirePack({ unitOfWork, memberships, packs, audit, clock }),
    getProduct: createGetProduct({ unitOfWork, products }),
    listProducts: createListProducts({ unitOfWork, products }),
    getCategory: createGetCategory({ unitOfWork, categories }),
    listCategories: createListCategories({ unitOfWork, categories }),
    listProductPacks: createListProductPacks({ unitOfWork, products, packs }),
    listProductPriceHistory: createListProductPriceHistory({ unitOfWork, products, prices }),
    listUnitsOfMeasure: createListUnitsOfMeasure({ unitOfWork, units }),
    recordOpeningStock: createRecordOpeningStock({ ...stock, openings: repos.inventoryOpeningBatches }),
    postGoodsReceipt: createPostGoodsReceipt({ ...stock, receipts: repos.goodsReceipts }),
    recordAdjustment: createRecordAdjustment({ ...stock, adjustments: repos.inventoryAdjustments }),
    recordWriteOff: createRecordWriteOff({ ...stock, adjustments: repos.inventoryAdjustments }),
    reverseGoodsReceipt: createReverseGoodsReceipt({ ...stock, receipts: repos.goodsReceipts }),
    reverseAdjustment: createReverseAdjustment({ ...stock, adjustments: repos.inventoryAdjustments }),
    setLowStockThreshold: createSetLowStockThreshold({ ...stock, thresholds: repos.inventoryThresholds }),
    clearLowStockThreshold: createClearLowStockThreshold({ ...stock, thresholds: repos.inventoryThresholds }),
    createStocktake: createCreateStocktake(stocktaking),
    recordStocktakeCount: createRecordStocktakeCount(stocktaking),
    removeStocktakeLine: createRemoveStocktakeLine(stocktaking),
    postStocktake: createPostStocktake(stocktaking),
    cancelStocktake: createCancelStocktake(stocktaking),
    listInventoryItems: createListInventoryItems(stockReads),
    getInventoryItem: createGetInventoryItem(stockReads),
    listItemMovements: createListItemMovements(stockReads),
    getOpeningBatch: createGetOpeningBatch(stockReads),
    getGoodsReceipt: createGetGoodsReceipt(stockReads),
    getAdjustment: createGetAdjustment(stockReads),
    listStocktakes: createListStocktakes(stocktakeQueries),
    getStocktake: createGetStocktake(stocktakeQueries),
    listStocktakeLines: createListStocktakeLines(stocktakeQueries),
  });
}
