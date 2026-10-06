import type { FixtureEnv } from "./fixture-safety.js";
import { withFixtureSession } from "./fixture-session.js";

/*
 * Controlled setup and inspection of the Build 1 tables for integration tests
 * in any package (database and API). Everything here is destructive or reads
 * across tenants, so every entry point fails closed unless all of these hold,
 * checked before any statement:
 *
 * 1. the process is explicitly the test environment: TALI_ENV=test;
 * 2. the target is the configured integration-test database
 *    (TEST_MIGRATION_DATABASE_URL, default docker-compose `postgres-test`):
 *    a loopback host and a database named *_test;
 * 3. the live session confirms it: current_database() and current_user are
 *    exactly that database and role.
 *
 * Statements run as the owner role, which the application role never is.
 * Every statement is fixed SQL with bound parameters. Never imported by
 * production code.
 */

type Env = FixtureEnv;

/**
 * The tenant-owned tables that tests write through the application. Reset
 * between tests in the disposable test database only; `currencies` and
 * `units_of_measure` are reference data and are never truncated.
 */
export const TENANCY_TABLES = [
  "product_variant_prices",
  "product_packs",
  "product_variants",
  "products",
  "product_categories",
  "business_idempotency_records",
  "user_idempotency_records",
  "business_audit_records",
  "platform_audit_records",
  "business_invitations",
  "devices",
  "business_memberships",
  "business_locations",
  "businesses",
  "external_identities",
  "users",
] as const;

/**
 * Legitimate ISO 4217 currencies added as test-only reference rows (ADR-005
 * section 5), with different minor-unit exponents, so tests prove no
 * currency is special-cased. Never part of a migration.
 */
export const TEST_CURRENCIES = [
  { code: "KES", minorUnitDigits: 2 },
  { code: "JPY", minorUnitDigits: 0 },
  { code: "BHD", minorUnitDigits: 3 },
] as const;

export async function resetTenancyTables(env: Env = process.env): Promise<void> {
  await withFixtureSession(env, async (client) => {
    await client.query(`TRUNCATE ${TENANCY_TABLES.map((table) => `public.${table}`).join(", ")}`);
  });
}

export async function addTestCurrencies(env: Env = process.env): Promise<void> {
  await withFixtureSession(env, async (client) => {
    for (const currency of TEST_CURRENCIES) {
      await client.query(
        `INSERT INTO public.currencies (code, minor_unit_digits) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`,
        [currency.code, currency.minorUnitDigits],
      );
    }
  });
}

/** Removes the test-only currencies; runs after the tenancy tables are reset, so nothing references them. */
export async function removeTestCurrencies(env: Env = process.env): Promise<void> {
  await withFixtureSession(env, async (client) => {
    await client.query(`DELETE FROM public.currencies WHERE code = ANY($1::text[])`, [
      TEST_CURRENCIES.map((currency) => currency.code),
    ]);
  });
}

/**
 * State changes that later slices' use cases will make (disable a user,
 * suspend a business or membership, add a member, archive a location). Tests
 * use them to set up authorization scenarios the Slice 3 API cannot create.
 */
export const tenancyFixtures = {
  async setUserStatus(userId: string, status: "ACTIVE" | "DISABLED", env: Env = process.env): Promise<void> {
    await updateOne(env, `UPDATE public.users SET status = $2, updated_at = now() WHERE id = $1`, [userId, status]);
  },

  async setBusinessStatus(businessId: string, status: "ACTIVE" | "SUSPENDED", env: Env = process.env): Promise<void> {
    await updateOne(env, `UPDATE public.businesses SET status = $2, updated_at = now() WHERE id = $1`, [
      businessId,
      status,
    ]);
  },

  async setMembershipStatus(
    membershipId: string,
    status: "ACTIVE" | "SUSPENDED",
    env: Env = process.env,
  ): Promise<void> {
    await updateOne(
      env,
      `UPDATE public.business_memberships SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`,
      [membershipId, status],
    );
  },

  async insertMembership(
    membership: {
      readonly id: string;
      readonly businessId: string;
      readonly userId: string;
      readonly role: "OWNER" | "MANAGER" | "CASHIER" | "STOCK_KEEPER" | "ACCOUNTANT";
      readonly status?: "ACTIVE" | "SUSPENDED";
    },
    env: Env = process.env,
  ): Promise<void> {
    await withFixtureSession(env, async (client) => {
      await client.query(
        `INSERT INTO public.business_memberships (business_id, id, user_id, role, status, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 1, now(), now())`,
        [membership.businessId, membership.id, membership.userId, membership.role, membership.status ?? "ACTIVE"],
      );
    });
  },

  /** Archives a location; an archived location is never the default. */
  async archiveLocation(locationId: string, env: Env = process.env): Promise<void> {
    await updateOne(
      env,
      `UPDATE public.business_locations SET status = 'ARCHIVED', is_default = false, updated_at = now() WHERE id = $1`,
      [locationId],
    );
  },

  /** Moves a PENDING invitation's creation and expiry into the past, so it is expired now. */
  async expireInvitation(invitationId: string, env: Env = process.env): Promise<void> {
    await updateOne(
      env,
      `UPDATE public.business_invitations
       SET created_at = now() - interval '73 hours', expires_at = now() - interval '1 hour'
       WHERE id = $1 AND status = 'PENDING'`,
      [invitationId],
    );
  },
};

async function updateOne(env: Env, sql: string, values: readonly unknown[]): Promise<void> {
  await withFixtureSession(env, async (client) => {
    const result = await client.query(sql, [...values]);
    if (result.rowCount !== 1) throw new Error(`fixture update matched ${String(result.rowCount)} rows, expected 1`);
  });
}

/** Plain rows for assertions (no Prisma types), across every tenant; test database only. */
export interface TenancySnapshot {
  readonly users: readonly { id: string; displayName: string; status: string }[];
  readonly externalIdentities: readonly { id: string; userId: string; provider: string; providerSubject: string }[];
  readonly businesses: readonly {
    id: string;
    name: string;
    currencyCode: string;
    timeZone: string;
    status: string;
    createdByUserId: string;
  }[];
  readonly locations: readonly { id: string; businessId: string; name: string; isDefault: boolean; status: string }[];
  readonly memberships: readonly {
    id: string;
    businessId: string;
    userId: string;
    role: string;
    status: string;
    version: number;
  }[];
  readonly platformAudit: readonly {
    action: string;
    entityType: string;
    entityId: string;
    subjectUserId: string;
    actorType: string;
    actorUserId: string | null;
    sourceChannel: string;
    correlationId: string;
    idempotencyKey: string | null;
    payloadText: string;
  }[];
  readonly businessAudit: readonly {
    businessId: string;
    action: string;
    entityType: string;
    entityId: string;
    actorType: string;
    actorUserId: string | null;
    actorMembershipId: string | null;
    deviceId: string | null;
    locationId: string | null;
    sourceChannel: string;
    correlationId: string;
    idempotencyKey: string | null;
    payloadText: string;
  }[];
  readonly userIdempotency: readonly {
    userId: string;
    operation: string;
    idempotencyKey: string;
    fingerprintHex: string;
    fingerprintVersion: number;
    resourceType: string;
    resourceId: string;
    resultText: string;
  }[];
  readonly businessIdempotency: readonly {
    businessId: string;
    actorType: string;
    actorId: string;
    operation: string;
    idempotencyKey: string;
    resourceType: string;
    resourceId: string;
    resultText: string;
  }[];
  readonly invitations: readonly {
    id: string;
    businessId: string;
    tokenHashHex: string;
    role: string;
    status: string;
    createdByMembershipId: string;
    acceptedByMembershipId: string | null;
    revokedByMembershipId: string | null;
  }[];
  readonly devices: readonly {
    id: string;
    businessId: string;
    platform: string;
    label: string;
    credentialHashHex: string;
    status: string;
    registeredByMembershipId: string;
    revokedByMembershipId: string | null;
  }[];
}

export async function readTenancySnapshot(env: Env = process.env): Promise<TenancySnapshot> {
  return withFixtureSession(env, async (client) => {
    const rows = async <Row>(sql: string): Promise<Row[]> => (await client.query(sql)).rows as Row[];
    return {
      users: await rows(`SELECT id, display_name AS "displayName", status FROM public.users ORDER BY id`),
      externalIdentities: await rows(
        `SELECT id, user_id AS "userId", provider, provider_subject AS "providerSubject"
         FROM public.external_identities ORDER BY id`,
      ),
      businesses: await rows(
        `SELECT id, name, currency_code AS "currencyCode", time_zone AS "timeZone", status,
                created_by_user_id AS "createdByUserId"
         FROM public.businesses ORDER BY id`,
      ),
      locations: await rows(
        `SELECT id, business_id AS "businessId", name, is_default AS "isDefault", status
         FROM public.business_locations ORDER BY id`,
      ),
      memberships: await rows(
        `SELECT id, business_id AS "businessId", user_id AS "userId", role, status, version
         FROM public.business_memberships ORDER BY id`,
      ),
      platformAudit: await rows(
        `SELECT action, entity_type AS "entityType", entity_id AS "entityId", subject_user_id AS "subjectUserId",
                actor_type AS "actorType", actor_user_id AS "actorUserId", source_channel AS "sourceChannel",
                correlation_id AS "correlationId", idempotency_key AS "idempotencyKey", payload::text AS "payloadText"
         FROM public.platform_audit_records ORDER BY id`,
      ),
      businessAudit: await rows(
        `SELECT business_id AS "businessId", action, entity_type AS "entityType", entity_id AS "entityId",
                actor_type AS "actorType", actor_user_id AS "actorUserId", actor_membership_id AS "actorMembershipId",
                device_id AS "deviceId", location_id AS "locationId", source_channel AS "sourceChannel",
                correlation_id AS "correlationId", idempotency_key AS "idempotencyKey", payload::text AS "payloadText"
         FROM public.business_audit_records ORDER BY id`,
      ),
      userIdempotency: await rows(
        `SELECT user_id AS "userId", operation, idempotency_key AS "idempotencyKey",
                encode(fingerprint, 'hex') AS "fingerprintHex", fingerprint_version AS "fingerprintVersion",
                resource_type AS "resourceType", resource_id AS "resourceId", result::text AS "resultText"
         FROM public.user_idempotency_records ORDER BY id`,
      ),
      businessIdempotency: await rows(
        `SELECT business_id AS "businessId", actor_type AS "actorType", actor_id AS "actorId", operation,
                idempotency_key AS "idempotencyKey", resource_type AS "resourceType", resource_id AS "resourceId",
                result::text AS "resultText"
         FROM public.business_idempotency_records ORDER BY id`,
      ),
      invitations: await rows(
        `SELECT id, business_id AS "businessId", encode(token_hash, 'hex') AS "tokenHashHex", role, status,
                created_by_membership_id AS "createdByMembershipId",
                accepted_by_membership_id AS "acceptedByMembershipId",
                revoked_by_membership_id AS "revokedByMembershipId"
         FROM public.business_invitations ORDER BY id`,
      ),
      devices: await rows(
        `SELECT id, business_id AS "businessId", platform, label, encode(credential_hash, 'hex') AS "credentialHashHex",
                status, registered_by_membership_id AS "registeredByMembershipId",
                revoked_by_membership_id AS "revokedByMembershipId"
         FROM public.devices ORDER BY id`,
      ),
    };
  });
}

/** Plain catalog rows for assertions (no Prisma types; money and factors as text), across every tenant. */
export interface CatalogSnapshot {
  readonly products: readonly { id: string; businessId: string; name: string; status: string; version: number }[];
  readonly variants: readonly {
    id: string;
    businessId: string;
    productId: string;
    isDefault: boolean;
    status: string;
    priceMinorText: string | null;
    priceVersion: number;
  }[];
  readonly categories: readonly { id: string; businessId: string; name: string; status: string }[];
  readonly packs: readonly { id: string; businessId: string; variantId: string; factorText: string; status: string }[];
  readonly prices: readonly {
    id: string;
    businessId: string;
    variantId: string;
    amountText: string;
    version: number;
  }[];
}

export async function readCatalogSnapshot(env: Env = process.env): Promise<CatalogSnapshot> {
  return withFixtureSession(env, async (client) => {
    const rows = async <Row>(sql: string): Promise<Row[]> => (await client.query(sql)).rows as Row[];
    return {
      products: await rows(
        `SELECT id, business_id AS "businessId", name, status, version FROM public.products ORDER BY id`,
      ),
      variants: await rows(
        `SELECT id, business_id AS "businessId", product_id AS "productId", is_default AS "isDefault", status,
                current_price_minor::text AS "priceMinorText", price_version AS "priceVersion"
         FROM public.product_variants ORDER BY id`,
      ),
      categories: await rows(
        `SELECT id, business_id AS "businessId", name, status FROM public.product_categories ORDER BY id`,
      ),
      packs: await rows(
        `SELECT id, business_id AS "businessId", variant_id AS "variantId", factor_minor::text AS "factorText", status
         FROM public.product_packs ORDER BY id`,
      ),
      prices: await rows(
        `SELECT id, business_id AS "businessId", variant_id AS "variantId", amount_minor::text AS "amountText",
                price_version AS version
         FROM public.product_variant_prices ORDER BY id`,
      ),
    };
  });
}
