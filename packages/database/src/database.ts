import {
  type AuditWriter,
  type BusinessIdempotencyStore,
  type BusinessRepository,
  type CurrencyReferenceRepository,
  DependencyUnavailableError,
  type DeviceRepository,
  type GoodsReceiptRepository,
  type InventoryAdjustmentRepository,
  type InventoryMovementRepository,
  type InvitationRepository,
  type LocationRepository,
  type MembershipRepository,
  type OpeningBatchRepository,
  type ProductCategoryRepository,
  type ProductPackRepository,
  type ProductPriceHistoryRepository,
  type ProductRepository,
  type StockBalanceRepository,
  type StockThresholdRepository,
  type UnitOfWork,
  type UnitReferenceRepository,
  type UserIdempotencyStore,
  type UserRepository,
  type VariantInventoryStateReader,
} from "@tali/application";
import { createPrismaClient } from "./client/prisma-client.js";
import { createAuditWriter } from "./repositories/audit-writer.js";
import { createBusinessIdempotencyStore } from "./repositories/business-idempotency-store.js";
import { createBusinessRepository, createCurrencyReferenceRepository } from "./repositories/business-repository.js";
import { createDeviceRepository } from "./repositories/device-repository.js";
import { createGoodsReceiptRepository } from "./repositories/goods-receipt-repository.js";
import { createInventoryAdjustmentRepository } from "./repositories/inventory-adjustment-repository.js";
import { createInventoryBalanceRepository } from "./repositories/inventory-balance-repository.js";
import { createInventoryMovementRepository } from "./repositories/inventory-movement-repository.js";
import { createOpeningBatchRepository } from "./repositories/inventory-opening-batch-repository.js";
import { createInventoryStockThresholdRepository } from "./repositories/inventory-stock-threshold-repository.js";
import { createInvitationRepository } from "./repositories/invitation-repository.js";
import { createLocationRepository } from "./repositories/location-repository.js";
import { createMembershipRepository } from "./repositories/membership-repository.js";
import { createProductCategoryRepository } from "./repositories/product-category-repository.js";
import { createProductPackRepository } from "./repositories/product-pack-repository.js";
import { createProductPriceHistoryRepository } from "./repositories/product-price-history-repository.js";
import { createProductRepository } from "./repositories/product-repository.js";
import { createUnitReferenceRepository } from "./repositories/unit-reference-repository.js";
import { createUserIdempotencyStore } from "./repositories/user-idempotency-store.js";
import { createUserRepository } from "./repositories/user-repository.js";
import { createVariantInventoryStateReader } from "./repositories/variant-inventory-state-reader.js";
import { PrismaUnitOfWork } from "./unit-of-work/prisma-unit-of-work.js";

export interface DatabaseOptions {
  /** Application-role connection string (DATABASE_URL). Never the migration role. */
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly applicationName?: string;
  readonly transactionMaxWaitMs?: number;
  readonly transactionTimeoutMs?: number;
  /** PostgreSQL lock_timeout per transaction, at most 5000 ms (ADR-004 section 13). */
  readonly lockTimeoutMs?: number;
}

/**
 * The repository adapters, as application ports. They work only with this
 * database's unit of work. `variantInventoryState` is the only
 * VariantInventoryStateReader: it reads the authoritative inventory tables
 * (ADR-008 section 3.2; Plan 004 S5).
 */
export interface DatabaseRepositories {
  readonly users: UserRepository;
  readonly businesses: BusinessRepository;
  readonly memberships: MembershipRepository;
  readonly locations: LocationRepository;
  readonly currencies: CurrencyReferenceRepository;
  readonly invitations: InvitationRepository;
  readonly devices: DeviceRepository;
  readonly auditWriter: AuditWriter;
  readonly userIdempotency: UserIdempotencyStore;
  readonly businessIdempotency: BusinessIdempotencyStore;
  readonly products: ProductRepository;
  readonly productCategories: ProductCategoryRepository;
  readonly productPacks: ProductPackRepository;
  readonly productPriceHistory: ProductPriceHistoryRepository;
  readonly units: UnitReferenceRepository;
  readonly inventoryMovements: InventoryMovementRepository;
  readonly inventoryBalances: StockBalanceRepository;
  readonly inventoryOpeningBatches: OpeningBatchRepository;
  readonly goodsReceipts: GoodsReceiptRepository;
  readonly inventoryAdjustments: InventoryAdjustmentRepository;
  readonly inventoryThresholds: StockThresholdRepository;
  readonly variantInventoryState: VariantInventoryStateReader;
}

/**
 * The database as seen by composition roots (apps/api, apps/worker). Exposes
 * only application ports and lifecycle; Prisma stays inside this package.
 */
export interface Database {
  readonly unitOfWork: UnitOfWork;
  readonly repositories: DatabaseRepositories;
  /** Round-trips to PostgreSQL. Rejects with DependencyUnavailableError when unreachable. */
  ping(): Promise<void>;
  disconnect(): Promise<void>;
}

export function createRepositories(): DatabaseRepositories {
  return Object.freeze({
    users: createUserRepository(),
    businesses: createBusinessRepository(),
    memberships: createMembershipRepository(),
    locations: createLocationRepository(),
    currencies: createCurrencyReferenceRepository(),
    invitations: createInvitationRepository(),
    devices: createDeviceRepository(),
    auditWriter: createAuditWriter(),
    userIdempotency: createUserIdempotencyStore(),
    businessIdempotency: createBusinessIdempotencyStore(),
    products: createProductRepository(),
    productCategories: createProductCategoryRepository(),
    productPacks: createProductPackRepository(),
    productPriceHistory: createProductPriceHistoryRepository(),
    units: createUnitReferenceRepository(),
    inventoryMovements: createInventoryMovementRepository(),
    inventoryBalances: createInventoryBalanceRepository(),
    inventoryOpeningBatches: createOpeningBatchRepository(),
    goodsReceipts: createGoodsReceiptRepository(),
    inventoryAdjustments: createInventoryAdjustmentRepository(),
    inventoryThresholds: createInventoryStockThresholdRepository(),
    variantInventoryState: createVariantInventoryStateReader(),
  });
}

export function createDatabase(options: DatabaseOptions): Database {
  const client = createPrismaClient({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    ...(options.connectionTimeoutMs === undefined ? {} : { connectionTimeoutMs: options.connectionTimeoutMs }),
    ...(options.applicationName === undefined ? {} : { applicationName: options.applicationName }),
  });
  const unitOfWork = new PrismaUnitOfWork(client, {
    maxWaitMs: options.transactionMaxWaitMs ?? 5_000,
    timeoutMs: options.transactionTimeoutMs ?? 15_000,
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
  });

  return {
    unitOfWork,
    repositories: createRepositories(),
    async ping() {
      try {
        await client.$queryRaw`SELECT 1`;
      } catch (error) {
        throw new DependencyUnavailableError("PostgreSQL is unreachable", { cause: error });
      }
    },
    async disconnect() {
      await client.$disconnect();
    },
  };
}
