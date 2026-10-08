import {
  type AcceptInvitation,
  type AddPack,
  type ArchiveCategory,
  type ArchiveProduct,
  AuditRecorder,
  type BusinessContextResolver,
  type ChangeMemberRole,
  type Clock,
  type CreateBusiness,
  type CreateCategory,
  type CreateInvitation,
  type CreateProduct,
  createAcceptInvitation,
  createAddPack,
  createArchiveCategory,
  createArchiveProduct,
  createBusinessContextResolver,
  createChangeMemberRole,
  createCreateBusiness,
  createCreateCategory,
  createCreateInvitation,
  createCreateProduct,
  createDefaultLocationCreation,
  createDefaultLocationResolver,
  createDeviceVerifier,
  createGetBusiness,
  createGetBusinessCurrency,
  createGetCategory,
  createGetCurrentUser,
  createGetProduct,
  createListCategories,
  createListDevices,
  createListLocations,
  createListMembers,
  createListMyBusinesses,
  createListProductPacks,
  createListProductPriceHistory,
  createListProducts,
  createListUnitsOfMeasure,
  createReactivateMember,
  createReactivateProduct,
  createRegisterCurrentUser,
  createRegisterDevice,
  createRetirePack,
  createRevokeDevice,
  createRevokeInvitation,
  createSetSellingPrice,
  createSuspendMember,
  createUpdateBusinessName,
  createUpdateCategory,
  createUpdateProduct,
  createUserContextResolver,
  type DefaultLocationResolver,
  type DeviceVerifier,
  type FingerprintHasher,
  type GetBusiness,
  type GetBusinessCurrency,
  type GetCategory,
  type GetCurrentUser,
  type GetProduct,
  type IdGenerator,
  KeyedIdempotency,
  type ListCategories,
  type ListDevices,
  type ListLocations,
  type ListMembers,
  type ListMyBusinesses,
  type ListProductPacks,
  type ListProductPriceHistory,
  type ListProducts,
  type ListUnitsOfMeasure,
  type OneTimeSecretGenerator,
  type ReactivateMember,
  type ReactivateProduct,
  type RegisterCurrentUser,
  type RegisterDevice,
  type RetirePack,
  type RevokeDevice,
  type RevokeInvitation,
  type SecretHasher,
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
}

/**
 * Composes the Build 1 and Build 2 catalog use cases over the PostgreSQL adapters: one unit of
 * work, the PostgreSQL audit writer and idempotency stores, the SHA-256
 * fingerprint hasher, the UUIDv7 generator and the node:crypto one-time
 * secret adapters. Transaction semantics are exactly those of the unit of
 * work; nothing here opens transactions. UpdateProduct's inventory guard
 * reads the authoritative inventory tables through the database's
 * variantInventoryState reader (movements, balances and configured low-stock
 * thresholds at every location).
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
  });
}
