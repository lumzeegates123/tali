import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useFixtureHarness, uuid } from "../support/harness.js";
import { appPool, sqlState } from "../support/pg.js";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const NOW = "2026-09-29T08:00:00.000Z";
const EXPIRES = "2026-10-02T08:00:00.000Z";
const AFTER_EXPIRY = "2026-10-03T08:00:00.000Z";

const USER_A = uuid(0xa1);
const USER_B = uuid(0xb1);
const BUSINESS_A = uuid(0xa2);
const BUSINESS_B = uuid(0xb2);
const MEMBERSHIP_A = uuid(0xa4);
const MEMBERSHIP_B = uuid(0xb4);

let nextId = 0x2000;
const freshId = () => uuid(nextId++);
const digest = (fill: number, length = 32) => Buffer.alloc(length, fill);

/**
 * Database-enforced invariants of the Slice 5 tables, exercised directly as
 * the application role: 32-byte digests, a globally unique token digest,
 * status/timestamp shapes, the Android-only platform, and composite tenant
 * foreign keys for every membership and device reference (ADR-005 sections
 * 14, 15 and 19).
 */
describe("invitation and device schema constraints (as tali_app)", () => {
  const { owner } = useFixtureHarness();
  let app: pg.Pool;

  beforeAll(() => {
    app = appPool();
  });

  afterAll(async () => {
    await app.end();
  });

  beforeEach(async () => {
    for (const [business, user, membership] of [
      [BUSINESS_A, USER_A, MEMBERSHIP_A],
      [BUSINESS_B, USER_B, MEMBERSHIP_B],
    ]) {
      await owner.query(
        `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'ACTIVE', $2, $2)`,
        [user, NOW],
      );
      await owner.query(
        `INSERT INTO businesses (id, name, currency_code, time_zone, status, created_by_user_id, created_at, updated_at)
         VALUES ($1, 'Shop', 'NGN', 'Africa/Lagos', 'ACTIVE', $2, $3, $3)`,
        [business, user, NOW],
      );
      await owner.query(
        `INSERT INTO business_memberships (business_id, id, user_id, role, status, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', 1, $4, $4)`,
        [business, membership, user, NOW],
      );
    }
  });

  interface InvitationRow {
    business?: string;
    id?: string;
    tokenHash?: Buffer;
    role?: string;
    status?: string;
    expiresAt?: string;
    createdBy?: string;
    createdAt?: string;
    acceptedBy?: string | null;
    acceptedAt?: string | null;
    revokedBy?: string | null;
    revokedAt?: string | null;
  }

  const insertInvitation = (row: InvitationRow = {}) =>
    app.query(
      `INSERT INTO business_invitations (business_id, id, token_hash, role, status, expires_at, created_by_membership_id,
         created_at, accepted_by_membership_id, accepted_at, revoked_by_membership_id, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        row.business ?? BUSINESS_A,
        row.id ?? freshId(),
        row.tokenHash ?? digest(nextId % 256),
        row.role ?? "CASHIER",
        row.status ?? "PENDING",
        row.expiresAt ?? EXPIRES,
        row.createdBy ?? MEMBERSHIP_A,
        row.createdAt ?? NOW,
        row.acceptedBy ?? null,
        row.acceptedAt ?? null,
        row.revokedBy ?? null,
        row.revokedAt ?? null,
      ],
    );

  interface DeviceRow {
    business?: string;
    platform?: string;
    label?: string;
    credentialHash?: Buffer;
    status?: string;
    registeredBy?: string;
    revokedBy?: string | null;
    revokedAt?: string | null;
  }

  const insertDevice = (row: DeviceRow = {}, id = freshId()) =>
    app.query(
      `INSERT INTO devices (business_id, id, platform, label, credential_hash, status, registered_by_membership_id,
         registered_at, revoked_by_membership_id, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.business ?? BUSINESS_A,
        id,
        row.platform ?? "ANDROID",
        row.label ?? "Counter phone",
        row.credentialHash ?? digest(7),
        row.status ?? "ACTIVE",
        row.registeredBy ?? MEMBERSHIP_A,
        NOW,
        row.revokedBy ?? null,
        row.revokedAt ?? null,
      ],
    );

  describe("business_invitations", () => {
    it("accepts exactly the four invitable roles, never OWNER", async () => {
      for (const role of ["MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"]) await insertInvitation({ role });
      for (const role of ["OWNER", "cashier", "ADMIN"]) {
        expect(await sqlState(insertInvitation({ role }))).toBe(CHECK_VIOLATION);
      }
    });

    it("stores a 32-byte digest that is globally unique across businesses", async () => {
      expect(await sqlState(insertInvitation({ tokenHash: digest(1, 31) }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertInvitation({ tokenHash: digest(1, 33) }))).toBe(CHECK_VIOLATION);
      await insertInvitation({ tokenHash: digest(9) });
      expect(
        await sqlState(insertInvitation({ business: BUSINESS_B, createdBy: MEMBERSHIP_B, tokenHash: digest(9) })),
      ).toBe(UNIQUE_VIOLATION);
    });

    it("stores no EXPIRED status and requires expiry after creation", async () => {
      expect(await sqlState(insertInvitation({ status: "EXPIRED" }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertInvitation({ expiresAt: NOW }))).toBe(CHECK_VIOLATION);
    });

    it("acceptance and revocation columns match the status and fall in the valid window", async () => {
      await insertInvitation({ status: "ACCEPTED", acceptedBy: MEMBERSHIP_A, acceptedAt: NOW });
      await insertInvitation({ status: "REVOKED", revokedBy: MEMBERSHIP_A, revokedAt: AFTER_EXPIRY });
      const invalid: InvitationRow[] = [
        { status: "ACCEPTED" },
        { status: "ACCEPTED", acceptedBy: MEMBERSHIP_A },
        { status: "PENDING", acceptedBy: MEMBERSHIP_A, acceptedAt: NOW },
        { status: "ACCEPTED", acceptedBy: MEMBERSHIP_A, acceptedAt: EXPIRES },
        { status: "ACCEPTED", acceptedBy: MEMBERSHIP_A, acceptedAt: "2026-09-28T08:00:00.000Z" },
        { status: "REVOKED" },
        { status: "PENDING", revokedBy: MEMBERSHIP_A, revokedAt: NOW },
        { status: "REVOKED", revokedBy: MEMBERSHIP_A, revokedAt: "2026-09-28T08:00:00.000Z" },
      ];
      for (const row of invalid)
        expect(await sqlState(insertInvitation(row)), JSON.stringify(row)).toBe(CHECK_VIOLATION);
    });

    it("composite tenant keys: every membership reference stays in the invitation's business", async () => {
      expect(await sqlState(insertInvitation({ createdBy: MEMBERSHIP_B }))).toBe(FOREIGN_KEY_VIOLATION);
      expect(await sqlState(insertInvitation({ status: "ACCEPTED", acceptedBy: MEMBERSHIP_B, acceptedAt: NOW }))).toBe(
        FOREIGN_KEY_VIOLATION,
      );
      expect(await sqlState(insertInvitation({ status: "REVOKED", revokedBy: MEMBERSHIP_B, revokedAt: NOW }))).toBe(
        FOREIGN_KEY_VIOLATION,
      );
    });
  });

  describe("devices", () => {
    it("Android is the only platform; labels are trimmed 1..60 characters", async () => {
      await insertDevice();
      for (const platform of ["IOS", "android", "WEB"]) {
        expect(await sqlState(insertDevice({ platform }))).toBe(CHECK_VIOLATION);
      }
      await insertDevice({ label: "x".repeat(60) });
      for (const label of ["", " padded", "x".repeat(61)]) {
        expect(await sqlState(insertDevice({ label }))).toBe(CHECK_VIOLATION);
      }
    });

    it("a 32-byte credential digest, two statuses, and revocation columns that match the status", async () => {
      expect(await sqlState(insertDevice({ credentialHash: digest(1, 16) }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertDevice({ status: "LOST" }))).toBe(CHECK_VIOLATION);
      await insertDevice({ status: "REVOKED", revokedBy: MEMBERSHIP_A, revokedAt: NOW });
      expect(await sqlState(insertDevice({ status: "REVOKED" }))).toBe(CHECK_VIOLATION);
      expect(await sqlState(insertDevice({ revokedBy: MEMBERSHIP_A, revokedAt: NOW }))).toBe(CHECK_VIOLATION);
      expect(
        await sqlState(
          insertDevice({ status: "REVOKED", revokedBy: MEMBERSHIP_A, revokedAt: "2026-09-28T08:00:00.000Z" }),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it("composite tenant keys: membership references stay in the device's business", async () => {
      expect(await sqlState(insertDevice({ registeredBy: MEMBERSHIP_B }))).toBe(FOREIGN_KEY_VIOLATION);
      expect(await sqlState(insertDevice({ status: "REVOKED", revokedBy: MEMBERSHIP_B, revokedAt: NOW }))).toBe(
        FOREIGN_KEY_VIOLATION,
      );
    });

    it("the same credential digest may exist in two businesses (separate registrations)", async () => {
      await insertDevice({ credentialHash: digest(3) });
      await insertDevice({ business: BUSINESS_B, registeredBy: MEMBERSHIP_B, credentialHash: digest(3) });
    });

    it("an audit record's device must belong to the audit record's business", async () => {
      const deviceA = freshId();
      await insertDevice({}, deviceA);
      const insertAudit = (business: string, membership: string, user: string) =>
        app.query(
          `INSERT INTO business_audit_records (business_id, id, occurred_at, action, entity_type, entity_id,
             actor_type, actor_user_id, actor_membership_id, device_id, source_channel, correlation_id, payload,
             payload_schema_version)
           VALUES ($1, $2, $3, 'business.renamed', 'business', $1, 'user', $4, $5, $6, 'mobile', 'test', '{}', 1)`,
          [business, freshId(), NOW, user, membership, deviceA],
        );
      await insertAudit(BUSINESS_A, MEMBERSHIP_A, USER_A);
      expect(await sqlState(insertAudit(BUSINESS_B, MEMBERSHIP_B, USER_B))).toBe(FOREIGN_KEY_VIOLATION);
    });
  });
});
