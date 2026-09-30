import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useFixtureHarness, uuid } from "../support/harness.js";
import { appPool, sqlState } from "../support/pg.js";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const NOW = "2026-09-29T08:00:00.000Z";
const LATER = "2026-10-29T08:00:00.000Z";

const USER_A = uuid(0xa1);
const USER_B = uuid(0xb1);
const BUSINESS_A = uuid(0xa2);
const BUSINESS_B = uuid(0xb2);
const LOCATION_A = uuid(0xa3);
const LOCATION_B = uuid(0xb3);
const MEMBERSHIP_A = uuid(0xa4);
const MEMBERSHIP_B = uuid(0xb4);

let nextId = 0x1000;
const freshId = () => uuid(nextId++);

/**
 * Database-enforced invariants of the Build 1 schema, exercised directly as
 * the application role (the adapters are bypassed on purpose): the named
 * CHECKs, the partial unique index, and the composite tenant foreign keys
 * (ADR-005 sections 3 to 10 and 19).
 */
describe("Build 1 schema constraints (as tali_app)", () => {
  const { owner } = useFixtureHarness();
  let app: pg.Pool;

  beforeAll(() => {
    app = appPool();
  });

  afterAll(async () => {
    await app.end();
  });

  beforeEach(async () => {
    for (const [id, name] of [
      [USER_A, "Owner A"],
      [USER_B, "Owner B"],
    ]) {
      await owner.query(
        `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, $2, 'ACTIVE', $3, $3)`,
        [id, name, NOW],
      );
    }
    for (const [business, user, location, membership] of [
      [BUSINESS_A, USER_A, LOCATION_A, MEMBERSHIP_A],
      [BUSINESS_B, USER_B, LOCATION_B, MEMBERSHIP_B],
    ]) {
      await owner.query(
        `INSERT INTO businesses (id, name, currency_code, time_zone, status, created_by_user_id, created_at, updated_at)
         VALUES ($1, 'Shop', 'NGN', 'Africa/Lagos', 'ACTIVE', $2, $3, $3)`,
        [business, user, NOW],
      );
      await owner.query(
        `INSERT INTO business_locations (business_id, id, name, is_default, status, created_at, updated_at)
         VALUES ($1, $2, 'Main', true, 'ACTIVE', $3, $3)`,
        [business, location, NOW],
      );
      await owner.query(
        `INSERT INTO business_memberships (business_id, id, user_id, role, status, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', 1, $4, $4)`,
        [business, membership, user, NOW],
      );
    }
  });

  const insertIdentity = (provider: string, subject = `subject-${nextId}`) =>
    app.query(
      `INSERT INTO external_identities (id, user_id, provider, provider_subject, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [freshId(), USER_A, provider, subject, NOW],
    );

  describe("external_identities", () => {
    it("accepts COGNITO and LOCAL and rejects FAKE or any other provider", async () => {
      await insertIdentity("COGNITO");
      await insertIdentity("LOCAL");
      expect(await sqlState(insertIdentity("FAKE"))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertIdentity("cognito"))).toBe(CHECK_VIOLATION);
    });

    it("links one provider subject to one user only", async () => {
      await insertIdentity("LOCAL", "shared-subject");
      expect(await sqlState(insertIdentity("LOCAL", "shared-subject"))).toBe(UNIQUE_VIOLATION);
      await insertIdentity("COGNITO", "shared-subject");
    });

    it("rejects an empty or over-long subject", async () => {
      expect(await sqlState(insertIdentity("LOCAL", ""))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertIdentity("LOCAL", "s".repeat(256)))).toBe(CHECK_VIOLATION);
      await insertIdentity("LOCAL", "s".repeat(255));
    });
  });

  describe("users and businesses", () => {
    const insertUser = (displayName: string, status = "ACTIVE", updatedAt = NOW) =>
      app.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`, [
        freshId(),
        displayName,
        status,
        NOW,
        updatedAt,
      ]);
    const insertBusiness = (fields: { currency?: string; timeZone?: string; name?: string; status?: string }) =>
      app.query(
        `INSERT INTO businesses (id, name, currency_code, time_zone, status, created_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          freshId(),
          fields.name ?? "Shop",
          fields.currency ?? "NGN",
          fields.timeZone ?? "Africa/Lagos",
          fields.status ?? "ACTIVE",
          USER_A,
          NOW,
        ],
      );

    it("users: trimmed 1..100 character names, two statuses, updated_at >= created_at", async () => {
      await insertUser("Ada");
      expect(await sqlState(insertUser(" Ada"))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertUser(""))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertUser("a".repeat(101)))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertUser("Ada", "DELETED"))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertUser("Ada", "ACTIVE", "2026-09-28T08:00:00.000Z"))).toBe(CHECK_VIOLATION);
    });

    it("businesses: the currency must exist in the reference table", async () => {
      await insertBusiness({ currency: "KES" });
      expect(await sqlState(insertBusiness({ currency: "XXX" }))).toBe(FOREIGN_KEY_VIOLATION);
      expect(await sqlState(insertBusiness({ currency: "ngn" }))).toBe(FOREIGN_KEY_VIOLATION);
    });

    it("businesses: structural time zone, trimmed name and known status", async () => {
      expect(await sqlState(insertBusiness({ timeZone: "+01:00" }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertBusiness({ timeZone: "" }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertBusiness({ name: "Shop " }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertBusiness({ status: "CLOSED" }))).toBe(CHECK_VIOLATION);
    });
  });

  describe("business_locations", () => {
    const insertLocation = (business: string, isDefault: boolean, status: string) =>
      app.query(
        `INSERT INTO business_locations (business_id, id, name, is_default, status, created_at, updated_at)
         VALUES ($1, $2, 'Store', $3, $4, $5, $5)`,
        [business, freshId(), isDefault, status, NOW],
      );

    it("a default location must be ACTIVE", async () => {
      expect(await sqlState(insertLocation(BUSINESS_A, true, "ARCHIVED"))).toBe(CHECK_VIOLATION);
      expect(
        await sqlState(app.query(`UPDATE business_locations SET status = 'ARCHIVED' WHERE id = $1`, [LOCATION_A])),
      ).toBe(CHECK_VIOLATION);
    });

    it("at most one ACTIVE default location per business (partial unique index)", async () => {
      expect(await sqlState(insertLocation(BUSINESS_A, true, "ACTIVE"))).toBe(UNIQUE_VIOLATION);
      await insertLocation(BUSINESS_A, false, "ACTIVE");
      await insertLocation(BUSINESS_A, false, "ARCHIVED");
      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM business_locations WHERE business_id = $1 AND is_default`,
        [BUSINESS_A],
      );
      expect(Number(rows[0]?.n)).toBe(1);
    });
  });

  describe("business_memberships", () => {
    const insertMembership = (fields: { role?: string; status?: string; version?: number; user?: string }) =>
      app.query(
        `INSERT INTO business_memberships (business_id, id, user_id, role, status, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          BUSINESS_A,
          freshId(),
          fields.user ?? USER_B,
          fields.role ?? "CASHIER",
          fields.status ?? "ACTIVE",
          fields.version ?? 1,
          NOW,
        ],
      );

    it("accepts exactly the five approved roles", async () => {
      expect(await sqlState(insertMembership({ role: "ADMIN" }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertMembership({ role: "owner" }))).toBe(CHECK_VIOLATION);
      for (const role of ["OWNER", "MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"]) {
        const user = freshId();
        await owner.query(
          `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Member', 'ACTIVE', $2, $2)`,
          [user, NOW],
        );
        await insertMembership({ role, user });
      }
    });

    it("two statuses, a positive version, and one membership per user and business", async () => {
      expect(await sqlState(insertMembership({ status: "INVITED" }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertMembership({ version: 0 }))).toBe(CHECK_VIOLATION);
      await insertMembership({});
      expect(await sqlState(insertMembership({}))).toBe(UNIQUE_VIOLATION);
    });
  });

  describe("business_audit_records", () => {
    const insertAudit = (fields: {
      business?: string;
      actorType?: string;
      userId?: string | null;
      membershipId?: string | null;
      actorName?: string | null;
      locationId?: string | null;
      payload?: string;
      sourceChannel?: string;
      correlationId?: string;
      action?: string;
    }) =>
      app.query(
        `INSERT INTO business_audit_records (business_id, id, occurred_at, action, entity_type, entity_id, actor_type,
           actor_user_id, actor_membership_id, actor_name, location_id, source_channel, correlation_id, payload,
           payload_schema_version)
         VALUES ($1, $2, $3, $4, 'business', $1, $5, $6, $7, $8, $9, $10, $11, $12::json, 1)`,
        [
          fields.business ?? BUSINESS_A,
          freshId(),
          NOW,
          fields.action ?? "business.created",
          fields.actorType ?? "user",
          fields.userId === undefined ? USER_A : fields.userId,
          fields.membershipId === undefined ? MEMBERSHIP_A : fields.membershipId,
          fields.actorName ?? null,
          fields.locationId ?? null,
          fields.sourceChannel ?? "web",
          fields.correlationId ?? "corr-1",
          fields.payload ?? "{}",
        ],
      );

    it("the actor shape: a user names its membership; system and integration actors are named", async () => {
      await insertAudit({});
      await insertAudit({ actorType: "system", userId: null, membershipId: null, actorName: "retention-job" });
      expect(await sqlState(insertAudit({ membershipId: null }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertAudit({ actorName: "extra" }))).toBe(CHECK_VIOLATION);
      expect(
        await sqlState(insertAudit({ actorType: "system", userId: null, membershipId: null, actorName: null })),
      ).toBe(CHECK_VIOLATION);
      expect(
        await sqlState(insertAudit({ actorType: "ai", userId: null, membershipId: null, actorName: "model" })),
      ).toBe(CHECK_VIOLATION);
    });

    it("the envelope: action format, source channel, correlation ID and an object payload of at most 8 KiB", async () => {
      expect(await sqlState(insertAudit({ action: "BusinessCreated" }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertAudit({ sourceChannel: "email" }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertAudit({ correlationId: "has space" }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertAudit({ payload: "[]" }))).toBe(CHECK_VIOLATION);
      const exactly = (bytes: number) => JSON.stringify({ p: "x".repeat(bytes - 8) });
      expect(Buffer.byteLength(exactly(8192))).toBe(8192);
      await insertAudit({ payload: exactly(8192) });
      expect(await sqlState(insertAudit({ payload: exactly(8193) }))).toBe(CHECK_VIOLATION);
    });

    it("composite tenant keys: a membership or location of another business is rejected", async () => {
      expect(await sqlState(insertAudit({ membershipId: MEMBERSHIP_B }))).toBe(FOREIGN_KEY_VIOLATION);
      expect(await sqlState(insertAudit({ locationId: LOCATION_B }))).toBe(FOREIGN_KEY_VIOLATION);
      await insertAudit({ locationId: LOCATION_A });
      expect(await sqlState(insertAudit({ business: BUSINESS_B, userId: USER_A, membershipId: MEMBERSHIP_A }))).toBe(
        FOREIGN_KEY_VIOLATION,
      );
    });
  });

  describe("platform_audit_records", () => {
    const insertPlatform = (actorType: string, userId: string | null, actorName: string | null) =>
      app.query(
        `INSERT INTO platform_audit_records (id, occurred_at, action, entity_type, entity_id, subject_user_id, actor_type,
           actor_user_id, actor_name, source_channel, correlation_id, payload, payload_schema_version)
         VALUES ($1, $2, 'user.registered', 'user', $3, $3, $4, $5, $6, 'web', 'corr-1', '{}'::json, 1)`,
        [freshId(), NOW, USER_A, actorType, userId, actorName],
      );

    it("actors are the user or a named system process", async () => {
      await insertPlatform("user", USER_A, null);
      await insertPlatform("system", null, "retention-job");
      expect(await sqlState(insertPlatform("integration", null, "provider"))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertPlatform("user", null, null))).toBe(CHECK_VIOLATION);
    });
  });

  describe("idempotency records", () => {
    const insertUserRecord = (fields: {
      actorId?: string;
      fingerprint?: Buffer;
      expiresAt?: string;
      operation?: string;
    }) =>
      app.query(
        `INSERT INTO user_idempotency_records (user_id, id, actor_type, actor_id, operation, idempotency_key, fingerprint,
           fingerprint_version, result, resource_type, resource_id, created_at, expires_at)
         VALUES ($1, $2, 'user', $3, $4, $5, $6, 1, '{}'::json, 'business', $7, $8, $9)`,
        [
          USER_A,
          freshId(),
          fields.actorId ?? USER_A,
          fields.operation ?? "business.create.v1",
          freshId(),
          fields.fingerprint ?? Buffer.alloc(32, 7),
          BUSINESS_A,
          NOW,
          fields.expiresAt ?? LATER,
        ],
      );
    const insertBusinessRecord = (actorType: string, actorId: string, key = freshId()) =>
      app.query(
        `INSERT INTO business_idempotency_records (business_id, id, actor_type, actor_id, operation, idempotency_key,
           fingerprint, fingerprint_version, result, resource_type, resource_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, 'sale.record.v1', $5, $6, 1, '{}'::json, 'sale', $7, $8, $9)`,
        [BUSINESS_A, freshId(), actorType, actorId, key, Buffer.alloc(32, 7), freshId(), NOW, LATER],
      );

    it("user records: the actor is the user, a 32-byte fingerprint, a versioned operation", async () => {
      await insertUserRecord({});
      expect(await sqlState(insertUserRecord({ actorId: USER_B }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertUserRecord({ fingerprint: Buffer.alloc(31) }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertUserRecord({ fingerprint: Buffer.alloc(33) }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertUserRecord({ operation: "business.create" }))).toBe(CHECK_VIOLATION);
    });

    it("user records: retention is at least 30 days", async () => {
      await insertUserRecord({ expiresAt: "2026-10-29T08:00:00.000Z" });
      expect(await sqlState(insertUserRecord({ expiresAt: "2026-10-29T07:59:59.999Z" }))).toBe(CHECK_VIOLATION);
    });

    it("business records: user actors are identified by UUID; the actor is part of the key", async () => {
      await insertBusinessRecord("user", USER_A);
      await insertBusinessRecord("integration", "provider:webhook");
      expect(await sqlState(insertBusinessRecord("user", "not-a-uuid"))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertBusinessRecord("ai", "model"))).toBe(CHECK_VIOLATION);
      const shared = freshId();
      await insertBusinessRecord("user", USER_A, shared);
      await insertBusinessRecord("user", USER_B, shared);
      expect(await sqlState(insertBusinessRecord("user", USER_A, shared))).toBe(UNIQUE_VIOLATION);
    });
  });
});
