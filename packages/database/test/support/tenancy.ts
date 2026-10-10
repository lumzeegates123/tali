/**
 * Composes the Slice 1 use cases, the catalog write use cases, the Build 2
 * Slice 5 inventory use cases and the Slice 6 stocktake and inventory read
 * use cases over the PostgreSQL repositories and the Prisma
 * unit of work, as the API composition root does. Test
 * inputs only: the fingerprint hasher is the application's deterministic fake
 * (the real SHA-256 adapter arrives in Slice 3), identities come from the fake
 * identity provider, and failures are injected by wrapping a repository in a
 * test-only decorator, never through a production switch.
 */
import {
  type AcceptInvitation,
  type AddPack,
  type ArchiveProduct,
  AuditRecorder,
  type AuthenticatedUserContext,
  type BusinessContext,
  type ChangeMemberRole,
  type ClearLowStockThreshold,
  type CreateBusiness,
  type CreateBusinessInput,
  type CreateBusinessOutcome,
  type CreateInvitation,
  type CreateProduct,
  type CancelStocktake,
  type CreateStocktake,
  createAcceptInvitation,
  createAddPack,
  createArchiveProduct,
  createBusinessContextResolver,
  createCancelStocktake,
  createChangeMemberRole,
  createClearLowStockThreshold,
  createCreateBusiness,
  createCreateInvitation,
  createCreateProduct,
  createCreateStocktake,
  createDefaultLocationCreation,
  createDefaultLocationResolver,
  createDeviceVerifier,
  createGetAdjustment,
  createGetGoodsReceipt,
  createGetInventoryItem,
  createGetOpeningBatch,
  createGetStocktake,
  createListDevices,
  createListInventoryItems,
  createListItemMovements,
  createListLocations,
  createListMembers,
  createListMyBusinesses,
  createListStocktakeLines,
  createListStocktakes,
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
  createSuspendMember,
  createUpdateBusinessName,
  createUpdateProduct,
  createUserContextResolver,
  type DefaultLocationResolver,
  type DeviceVerifier,
  type GetAdjustment,
  type GetGoodsReceipt,
  type GetInventoryItem,
  type GetOpeningBatch,
  type GetStocktake,
  KeyedIdempotency,
  type ListDevices,
  type ListInventoryItems,
  type ListItemMovements,
  type ListLocations,
  type ListMembers,
  type ListMyBusinesses,
  type ListStocktakeLines,
  type ListStocktakes,
  type LocationBoundContext,
  parseCorrelationId,
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
  type SetLowStockThreshold,
  type SuspendMember,
  taliAuditRegistry,
  type UnitOfWork,
  type UpdateBusinessName,
  type UpdateProduct,
  type UserId,
} from "@tali/application";
import {
  FakeFingerprintHasher,
  FakeIdentityProvider,
  FakeOneTimeSecretGenerator,
  FakeSecretHasher,
  FixedClock,
  SequentialIdGenerator,
} from "@tali/application/testing";
import type { BusinessId, BusinessMembership, MembershipRole, MembershipStatus } from "@tali/domain";
import { restoreMembership } from "@tali/domain";
import { beforeEach } from "vitest";
import { createRepositories, type DatabaseRepositories } from "../../src/database.js";
import { PrismaUnitOfWork, type UnitOfWorkSettings } from "../../src/unit-of-work/prisma-unit-of-work.js";
import { useFixtureHarness } from "./harness.js";

export const TEST_CORRELATION_ID = parseCorrelationId("test-request");

export interface RegisteredUser {
  readonly userId: UserId;
  readonly context: AuthenticatedUserContext;
}

export interface Tenancy {
  readonly unitOfWork: UnitOfWork;
  readonly repositories: DatabaseRepositories;
  readonly registerCurrentUser: RegisterCurrentUser;
  readonly createBusiness: CreateBusiness;
  readonly listMyBusinesses: ListMyBusinesses;
  readonly listMembers: ListMembers;
  readonly listLocations: ListLocations;
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
  readonly deviceVerifier: DeviceVerifier;
  readonly defaultLocations: DefaultLocationResolver;
  readonly createProduct: CreateProduct;
  readonly updateProduct: UpdateProduct;
  readonly archiveProduct: ArchiveProduct;
  readonly reactivateProduct: ReactivateProduct;
  readonly addPack: AddPack;
  readonly retirePack: RetirePack;
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
  readonly listStocktakes: ListStocktakes;
  readonly getStocktake: GetStocktake;
  readonly listStocktakeLines: ListStocktakeLines;
  readonly listInventoryItems: ListInventoryItems;
  readonly getInventoryItem: GetInventoryItem;
  readonly listItemMovements: ListItemMovements;
  readonly getOpeningBatch: GetOpeningBatch;
  readonly getGoodsReceipt: GetGoodsReceipt;
  readonly getAdjustment: GetAdjustment;
  registeredUser(subject: string, displayName?: string): Promise<RegisteredUser>;
  create(user: RegisteredUser, input?: Partial<CreateBusinessInput>): Promise<CreateBusinessOutcome>;
  /** The server-resolved context of an ACTIVE member, as the API's BusinessContextGuard produces it. */
  contextFor(user: RegisteredUser, businessId: BusinessId): Promise<BusinessContext>;
  /** contextFor bound to the business's default location, as the API binds inventory requests. */
  boundContextFor(user: RegisteredUser, businessId: BusinessId): Promise<LocationBoundContext>;
}

/** Per-test deterministic inputs, shared by every composition in the test so identifiers never collide. */
interface World {
  readonly clock: FixedClock;
  readonly ids: SequentialIdGenerator;
  readonly hasher: FakeFingerprintHasher;
  readonly identities: FakeIdentityProvider;
  readonly secrets: FakeOneTimeSecretGenerator;
  readonly secretHasher: FakeSecretHasher;
}

function newWorld(): World {
  const clock = new FixedClock("2026-09-29T08:00:00.000Z");
  return {
    clock,
    ids: new SequentialIdGenerator(),
    hasher: new FakeFingerprintHasher(),
    identities: new FakeIdentityProvider(clock),
    secrets: new FakeOneTimeSecretGenerator(),
    secretHasher: new FakeSecretHasher(),
  };
}

export function useTenancyHarness() {
  const base = useFixtureHarness();
  const repositories = createRepositories();
  let world = newWorld();
  beforeEach(() => {
    world = newWorld();
  });

  function unitOfWorkWith(settings: Partial<UnitOfWorkSettings> = {}): PrismaUnitOfWork {
    return new PrismaUnitOfWork(base.client, { maxWaitMs: 5_000, timeoutMs: 15_000, ...settings });
  }

  function compose(
    options: { readonly unitOfWork?: UnitOfWork; readonly decorate?: Partial<DatabaseRepositories> } = {},
  ): Tenancy {
    const uow = options.unitOfWork ?? base.unitOfWork;
    const repos: DatabaseRepositories = { ...repositories, ...options.decorate };
    const { clock, ids, hasher, identities, secrets, secretHasher } = world;
    const { businesses, memberships, invitations, devices } = repos;
    const businessIdempotency = new KeyedIdempotency({ businessStore: repos.businessIdempotency, clock, ids });
    const userContexts = createUserContextResolver({ unitOfWork: uow, users: repos.users });
    const businessContexts = createBusinessContextResolver({ unitOfWork: uow, userContexts, businesses, memberships });
    const audit = new AuditRecorder({ registry: taliAuditRegistry, writer: repos.auditWriter, clock, ids });
    const registerCurrentUser = createRegisterCurrentUser({ unitOfWork: uow, users: repos.users, audit, ids, clock });
    const defaultLocations = createDefaultLocationResolver({ unitOfWork: uow, locations: repos.locations });
    const catalog = {
      unitOfWork: uow,
      memberships,
      products: repos.products,
      categories: repos.productCategories,
      packs: repos.productPacks,
      prices: repos.productPriceHistory,
      units: repos.units,
      audit,
      ids,
      clock,
    };
    const stock = {
      unitOfWork: uow,
      memberships,
      products: repos.products,
      packs: repos.productPacks,
      units: repos.units,
      movements: repos.inventoryMovements,
      balances: repos.inventoryBalances,
      idempotency: businessIdempotency,
      hasher,
      audit,
      ids,
      clock,
    };
    const stocktaking = { ...stock, stocktakes: repos.stocktakes, stocktakeLines: repos.stocktakeLines };
    const stocktakeQueries = { unitOfWork: uow, stocktakes: repos.stocktakes, stocktakeLines: repos.stocktakeLines };
    const reads = {
      unitOfWork: uow,
      items: repos.inventoryItems,
      movements: repos.inventoryMovements,
      openings: repos.inventoryOpeningBatches,
      receipts: repos.goodsReceipts,
      adjustments: repos.inventoryAdjustments,
    };
    const createBusiness = createCreateBusiness({
      unitOfWork: uow,
      users: repos.users,
      businesses: repos.businesses,
      memberships: repos.memberships,
      currencies: repos.currencies,
      defaultLocation: createDefaultLocationCreation({ locations: repos.locations, audit, ids }),
      idempotency: new KeyedIdempotency({ store: repos.userIdempotency, clock, ids }),
      hasher,
      audit,
      ids,
      clock,
    });
    return {
      unitOfWork: uow,
      repositories: repos,
      registerCurrentUser,
      createBusiness,
      listMyBusinesses: createListMyBusinesses({ unitOfWork: uow, users: repos.users, memberships: repos.memberships }),
      listMembers: createListMembers({ unitOfWork: uow, memberships: repos.memberships }),
      listLocations: createListLocations({ unitOfWork: uow, locations: repos.locations }),
      updateBusinessName: createUpdateBusinessName({ unitOfWork: uow, businesses, memberships, audit, clock }),
      changeMemberRole: createChangeMemberRole({ unitOfWork: uow, businesses, memberships, audit, clock }),
      suspendMember: createSuspendMember({ unitOfWork: uow, businesses, memberships, audit, clock }),
      reactivateMember: createReactivateMember({ unitOfWork: uow, businesses, memberships, audit, clock }),
      createInvitation: createCreateInvitation({
        unitOfWork: uow,
        memberships,
        invitations,
        idempotency: businessIdempotency,
        hasher,
        secrets,
        secretHasher,
        audit,
        ids,
        clock,
      }),
      revokeInvitation: createRevokeInvitation({ unitOfWork: uow, memberships, invitations, audit, clock }),
      acceptInvitation: createAcceptInvitation({
        unitOfWork: uow,
        users: repos.users,
        businesses,
        memberships,
        invitations,
        secretHasher,
        audit,
        ids,
        clock,
      }),
      registerDevice: createRegisterDevice({
        unitOfWork: uow,
        memberships,
        devices,
        idempotency: businessIdempotency,
        hasher,
        secrets,
        secretHasher,
        audit,
        ids,
        clock,
      }),
      listDevices: createListDevices({ unitOfWork: uow, devices }),
      revokeDevice: createRevokeDevice({ unitOfWork: uow, memberships, devices, audit, clock }),
      deviceVerifier: createDeviceVerifier({ unitOfWork: uow, devices, secretHasher }),
      defaultLocations,
      createProduct: createCreateProduct({ ...catalog, idempotency: businessIdempotency, hasher }),
      updateProduct: createUpdateProduct({ ...catalog, inventory: repos.variantInventoryState }),
      archiveProduct: createArchiveProduct(catalog),
      reactivateProduct: createReactivateProduct(catalog),
      addPack: createAddPack({ ...catalog, idempotency: businessIdempotency, hasher }),
      retirePack: createRetirePack(catalog),
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
      listStocktakes: createListStocktakes(stocktakeQueries),
      getStocktake: createGetStocktake(stocktakeQueries),
      listStocktakeLines: createListStocktakeLines(stocktakeQueries),
      listInventoryItems: createListInventoryItems(reads),
      getInventoryItem: createGetInventoryItem(reads),
      listItemMovements: createListItemMovements(reads),
      getOpeningBatch: createGetOpeningBatch(reads),
      getGoodsReceipt: createGetGoodsReceipt(reads),
      getAdjustment: createGetAdjustment(reads),
      contextFor(user, businessId) {
        return businessContexts.resolveForUser(user.context, businessId);
      },
      async boundContextFor(user, businessId) {
        return defaultLocations.resolveDefaultLocation(await businessContexts.resolveForUser(user.context, businessId));
      },
      async registeredUser(subject, displayName = "Test User") {
        const identity = await identities.verifyAccessToken(identities.issueToken(subject));
        const { user } = await registerCurrentUser.execute({
          identity,
          displayName,
          correlationId: TEST_CORRELATION_ID,
          sourceChannel: "web",
        });
        return {
          userId: user.id,
          context: { userId: user.id, correlationId: TEST_CORRELATION_ID, sourceChannel: "web" },
        };
      },
      create(user, input = {}) {
        return createBusiness.execute(user.context, {
          name: input.name ?? "Test Shop",
          currencyCode: input.currencyCode ?? "NGN",
          timeZone: input.timeZone ?? "Africa/Lagos",
          idempotencyKey: "idempotencyKey" in input ? input.idempotencyKey : ids.newId("IdempotencyKey"),
        });
      },
    };
  }

  /** Adds a membership through the repository (Slice 1 has no invitation use case yet). */
  async function addMember(
    businessId: BusinessId,
    user: RegisteredUser,
    role: MembershipRole,
    status: MembershipStatus = "ACTIVE",
  ): Promise<BusinessMembership> {
    const now = world.clock.now();
    const membership = restoreMembership({
      id: world.ids.newId("Membership"),
      businessId,
      userId: user.userId,
      role,
      status,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await base.unitOfWork.run((scope) => repositories.memberships.insert(scope, membership));
    return membership;
  }

  return { ...base, repositories, unitOfWorkWith, compose, addMember, world: () => world };
}
