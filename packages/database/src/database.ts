import {
  type AuditWriter,
  type BusinessIdempotencyStore,
  type BusinessRepository,
  type CurrencyReferenceRepository,
  DependencyUnavailableError,
  type DeviceRepository,
  type InvitationRepository,
  type LocationRepository,
  type MembershipRepository,
  type ProductCategoryRepository,
  type ProductPackRepository,
  type ProductPriceHistoryRepository,
  type ProductRepository,
  type UnitOfWork,
  type UnitReferenceRepository,
  type UserIdempotencyStore,
  type UserRepository,
} from "@tali/application";
import { createPrismaClient } from "./client/prisma-client.js";
import { createAuditWriter } from "./repositories/audit-writer.js";
import { createBusinessIdempotencyStore } from "./repositories/business-idempotency-store.js";
import { createBusinessRepository, createCurrencyReferenceRepository } from "./repositories/business-repository.js";
import { createDeviceRepository } from "./repositories/device-repository.js";
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
 * database's unit of work. There is deliberately no VariantInventoryStateReader:
 * the inventory module provides it (ADR-008 section 3.2; Plan 004 S3 and S5).
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
