import {
  type IdempotencyKey,
  IdempotencyInProgressError,
  type JsonValue,
  type UserIdempotencyRecord,
} from "@tali/application";
import {
  foundBusiness,
  parseBusinessName,
  parseBusinessTimeZoneId,
  parseCurrencyCode,
  parseDisplayName,
  parseUuid,
  registerUser,
  type UserId,
} from "@tali/domain";
import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_RESULT_MAX_BYTES } from "../../src/repositories/user-idempotency-store.js";
import { gate } from "../support/harness.js";
import { appPool, sqlState } from "../support/pg.js";
import { useTenancyHarness } from "../support/tenancy.js";

const THIRTY_DAYS_MS = 30 * 86_400_000;

/**
 * UserIdempotencyStore over PostgreSQL (ADR-004 sections 4.2, 4.3 and 13):
 * claim by INSERT ... ON CONFLICT DO NOTHING on (user_id, idempotency_key),
 * a byte-exact 16 KiB result limit, and the concurrent outcomes.
 */
describe("UserIdempotencyStore", () => {
  const harness = useTenancyHarness();
  const { owner, repositories } = harness;
  const store = repositories.userIdempotency;

  async function seedUser(): Promise<UserId> {
    const { ids, clock } = harness.world();
    const user = registerUser({ id: ids.newId("User"), displayName: parseDisplayName("Store User"), now: clock.now() });
    await owner.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, $2, 'ACTIVE', $3, $3)`,
      [user.id, user.displayName, user.createdAt],
    );
    return user.id;
  }

  function record(userId: UserId, overrides: Partial<UserIdempotencyRecord> = {}): UserIdempotencyRecord {
    const { ids, clock } = harness.world();
    const createdAt = clock.now();
    const digest = new Uint8Array(32).map((_, index) => index);
    return {
      id: ids.newId("IdempotencyRecord"),
      userId,
      operation: "business.create.v1",
      idempotencyKey: ids.newId("IdempotencyKey") as unknown as IdempotencyKey,
      fingerprint: { version: 1, digest },
      result: { ok: true },
      resourceType: "business",
      resourceId: parseUuid(ids.newId("Business")),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + THIRTY_DAYS_MS),
      ...overrides,
    };
  }

  /** A JSON object whose compact encoding is exactly `bytes` long, padded with `unit` (1 or 2 UTF-8 bytes). */
  function resultOfBytes(bytes: number, unit = "x"): JsonValue {
    const overhead = Buffer.byteLength(JSON.stringify({ pad: "" }), "utf8");
    const unitBytes = Buffer.byteLength(unit, "utf8");
    const count = Math.floor((bytes - overhead) / unitBytes);
    const value = { pad: unit.repeat(count) + "x".repeat(bytes - overhead - count * unitBytes) };
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBe(bytes);
    return value;
  }

  const recordCount = async () =>
    Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM user_idempotency_records`)).rows[0]?.n);

  it("round-trips a record exactly, including the 32-byte fingerprint and the JSON result", async () => {
    const userId = await seedUser();
    const stored = record(userId, { result: { business: { id: "b", name: "Ẹ̀kọ́ Stores" }, list: [1, 2, 3] } });
    await harness.unitOfWork.run(async (scope) => {
      expect(await store.insert(scope, stored)).toBe("inserted");
    });
    const found = await harness.unitOfWork.run((scope) => store.find(scope, userId, stored.idempotencyKey));
    expect(found).toEqual({ ...stored, fingerprint: { version: 1, digest: stored.fingerprint.digest } });
    const { rows } = await owner.query<{ bytes: number; text: string }>(
      `SELECT octet_length(result::text) AS bytes, result::text AS text FROM user_idempotency_records`,
    );
    expect(rows[0]?.text).toBe(JSON.stringify(stored.result));
    expect(rows[0]?.bytes).toBe(Buffer.byteLength(JSON.stringify(stored.result), "utf8"));
  });

  it("finds nothing for another user's key", async () => {
    const userId = await seedUser();
    const other = await seedUser();
    const stored = record(userId);
    await harness.unitOfWork.run((scope) => store.insert(scope, stored));
    await expect(harness.unitOfWork.run((scope) => store.find(scope, other, stored.idempotencyKey))).resolves.toBe(
      undefined,
    );
  });

  it("a committed duplicate key returns 'duplicate' and leaves the transaction usable", async () => {
    const userId = await seedUser();
    const first = record(userId);
    await harness.unitOfWork.run((scope) => store.insert(scope, first));
    const outcome = await harness.unitOfWork.run(async (scope) => {
      const result = await store.insert(scope, record(userId, { idempotencyKey: first.idempotencyKey }));
      const found = await store.find(scope, userId, first.idempotencyKey);
      return { result, foundId: found?.id };
    });
    expect(outcome).toEqual({ result: "duplicate", foundId: first.id });
    expect(await recordCount()).toBe(1);
  });

  describe("16 KiB result limit (byte-exact)", () => {
    it("accepts a result of exactly 16384 bytes", async () => {
      const userId = await seedUser();
      const stored = record(userId, { result: resultOfBytes(IDEMPOTENCY_RESULT_MAX_BYTES) });
      await harness.unitOfWork.run((scope) => store.insert(scope, stored));
      const { rows } = await owner.query<{ bytes: number }>(
        `SELECT octet_length(result::text) AS bytes FROM user_idempotency_records`,
      );
      expect(rows[0]?.bytes).toBe(16_384);
    });

    it("rejects 16385 bytes before writing, and the whole transaction rolls back (no partial mutation)", async () => {
      const userId = await seedUser();
      const { ids, clock } = harness.world();
      const business = foundBusiness({
        id: ids.newId("Business"),
        name: parseBusinessName("Written before the claim"),
        currencyCode: parseCurrencyCode("NGN"),
        timeZone: parseBusinessTimeZoneId("Africa/Lagos"),
        createdByUserId: userId,
        now: clock.now(),
      });
      await expect(
        harness.unitOfWork.run(async (scope) => {
          await repositories.businesses.insert(scope, business);
          await store.insert(scope, record(userId, { result: resultOfBytes(IDEMPOTENCY_RESULT_MAX_BYTES + 1) }));
        }),
      ).rejects.toThrow(/16385 bytes; the limit is 16384/);
      expect(await recordCount()).toBe(0);
      const businesses = await owner.query(`SELECT 1 FROM businesses`);
      expect(businesses.rows).toEqual([]);
    });

    it("counts UTF-8 bytes, not characters", async () => {
      const userId = await seedUser();
      const multibyte = resultOfBytes(IDEMPOTENCY_RESULT_MAX_BYTES + 1, "é");
      expect(JSON.stringify(multibyte).length).toBeLessThan(IDEMPOTENCY_RESULT_MAX_BYTES);
      await expect(
        harness.unitOfWork.run((scope) => store.insert(scope, record(userId, { result: multibyte }))),
      ).rejects.toThrow(/16385 bytes/);
      const exact = record(userId, { result: resultOfBytes(IDEMPOTENCY_RESULT_MAX_BYTES, "é") });
      await expect(harness.unitOfWork.run((scope) => store.insert(scope, exact))).resolves.toBe("inserted");
    });

    it("the database CHECK enforces the same limit independently of the adapter", async () => {
      const userId = await seedUser();
      const app = appPool();
      try {
        const insert = (result: JsonValue) => {
          const r = record(userId);
          return app.query(
            `INSERT INTO user_idempotency_records (user_id, id, actor_type, actor_id, operation, idempotency_key,
               fingerprint, fingerprint_version, result, resource_type, resource_id, created_at, expires_at)
             VALUES ($1, $2, 'user', $9, 'business.create.v1', $3, $4, 1, $5::json, 'business', $6, $7, $8)`,
            [
              r.userId,
              r.id,
              r.idempotencyKey,
              Buffer.from(r.fingerprint.digest),
              JSON.stringify(result),
              r.resourceId,
              r.createdAt,
              r.expiresAt,
              r.userId,
            ],
          );
        };
        expect(await sqlState(insert(resultOfBytes(IDEMPOTENCY_RESULT_MAX_BYTES + 1)))).toBe("23514");
        await insert(resultOfBytes(IDEMPOTENCY_RESULT_MAX_BYTES));
      } finally {
        await app.end();
      }
    });
  });

  describe("concurrent claims of one key", () => {
    async function holdClaim(userId: UserId, stored: UserIdempotencyRecord, outcome: "commit" | "rollback") {
      const claimed = gate();
      const release = gate();
      const failure = new Error("holder rolls back");
      const holder = harness.unitOfWork.run(async (scope) => {
        await store.insert(scope, stored);
        claimed.open();
        await release.opened;
        if (outcome === "rollback") throw failure;
      });
      await claimed.opened;
      return { holder, release: release.open, failure, userId };
    }

    it("waits for the holder; when it commits, the waiter gets 'duplicate'", async () => {
      const userId = await seedUser();
      const stored = record(userId);
      const { holder, release } = await holdClaim(userId, stored, "commit");
      const waiter = harness.unitOfWork.run((scope) =>
        store.insert(scope, record(userId, { idempotencyKey: stored.idempotencyKey })),
      );
      release();
      await holder;
      await expect(waiter).resolves.toBe("duplicate");
      expect(await recordCount()).toBe(1);
    });

    it("waits for the holder; when it rolls back, the waiter claims the key", async () => {
      const userId = await seedUser();
      const stored = record(userId);
      const { holder, release, failure } = await holdClaim(userId, stored, "rollback");
      const retry = record(userId, { idempotencyKey: stored.idempotencyKey });
      const waiter = harness.unitOfWork.run((scope) => store.insert(scope, retry));
      release();
      await expect(holder).rejects.toBe(failure);
      await expect(waiter).resolves.toBe("inserted");
      const { rows } = await owner.query(`SELECT id::text FROM user_idempotency_records`);
      expect(rows).toEqual([{ id: retry.id }]);
    });

    it("a wait past lock_timeout is IDEMPOTENCY_IN_PROGRESS (retryable), without waiting the default 5 s", async () => {
      const userId = await seedUser();
      const stored = record(userId);
      const { holder, release } = await holdClaim(userId, stored, "commit");
      const quick = harness.unitOfWorkWith({ lockTimeoutMs: 150 });
      const startedAt = performance.now();
      const error = await quick
        .run((scope) => store.insert(scope, record(userId, { idempotencyKey: stored.idempotencyKey })))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(IdempotencyInProgressError);
      expect((error as IdempotencyInProgressError).retryable).toBe(true);
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      release();
      await holder;
      expect(await recordCount()).toBe(1);
    });
  });
});
