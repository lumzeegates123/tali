import {
  type AuditWriter,
  IdempotencyInProgressError,
  IdempotencyKeyReusedError,
  type LocationRepository,
  ValidationError,
} from "@tali/application";
import { describe, expect, it } from "vitest";
import { gate } from "../support/harness.js";
import { useTenancyHarness } from "../support/tenancy.js";

/**
 * CreateBusiness composed over PostgreSQL (ADR-005 section 5; ADR-004
 * sections 4 and 9): one transaction creates the business, its single ACTIVE
 * default location, the OWNER membership, three audit records and the keyed
 * idempotency record, or nothing at all.
 */
describe("CreateBusiness over PostgreSQL", () => {
  const harness = useTenancyHarness();
  const { owner } = harness;

  const counts = async () => {
    const { rows } = await owner.query<Record<string, string>>(`
      SELECT (SELECT count(*) FROM businesses) AS businesses,
             (SELECT count(*) FROM business_locations) AS locations,
             (SELECT count(*) FROM business_memberships) AS memberships,
             (SELECT count(*) FROM business_audit_records) AS audit,
             (SELECT count(*) FROM user_idempotency_records) AS idempotency`);
    return Object.fromEntries(Object.entries(rows[0] ?? {}).map(([key, value]) => [key, Number(value)]));
  };
  const nothingCreated = { businesses: 0, locations: 0, memberships: 0, audit: 0, idempotency: 0 };
  const oneBusiness = { businesses: 1, locations: 1, memberships: 1, audit: 3, idempotency: 1 };

  it("creates everything atomically: one ACTIVE default location, one OWNER, three audit records, one key", async () => {
    const tenancy = harness.compose();
    const user = await tenancy.registeredUser("owner-subject");
    const outcome = await tenancy.create(user, { name: "Mama Put Provisions", currencyCode: "NGN" });

    expect(outcome.replayed).toBe(false);
    expect(await counts()).toEqual(oneBusiness);
    const { business, location, membership } = outcome.result;
    const locations = await owner.query(
      `SELECT id::text, is_default, status, name FROM business_locations WHERE business_id = $1`,
      [business.id],
    );
    expect(locations.rows).toEqual([
      { id: location.id, is_default: true, status: "ACTIVE", name: "Mama Put Provisions" },
    ]);
    const memberships = await owner.query(
      `SELECT user_id::text, role, status, version FROM business_memberships WHERE business_id = $1`,
      [business.id],
    );
    expect(memberships.rows).toEqual([{ user_id: user.userId, role: "OWNER", status: "ACTIVE", version: 1 }]);
    const audit = await owner.query<{ action: string; entity_id: string; actor_membership_id: string }>(
      `SELECT action, entity_id::text, actor_membership_id::text, idempotency_key::text AS key
       FROM business_audit_records WHERE business_id = $1 ORDER BY id`,
      [business.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(["business.created", "location.created", "membership.created"]);
    expect(new Set(audit.rows.map((row) => row.actor_membership_id))).toEqual(new Set([membership.id]));
    const stored = await owner.query(
      `SELECT operation, resource_type, resource_id::text, actor_type, actor_id FROM user_idempotency_records`,
    );
    expect(stored.rows).toEqual([
      {
        operation: "business.create.v1",
        resource_type: "business",
        resource_id: business.id,
        actor_type: "user",
        actor_id: user.userId,
      },
    ]);
  });

  it("creates a business in any approved currency, not only NGN", async () => {
    const tenancy = harness.compose();
    const user = await tenancy.registeredUser("yen-owner");
    const outcome = await tenancy.create(user, { currencyCode: "JPY", timeZone: "Asia/Tokyo" });
    expect(outcome.result.business.currencyCode).toBe("JPY");
    const { rows } = await owner.query(`SELECT currency_code FROM businesses`);
    expect(rows).toEqual([{ currency_code: "JPY" }]);
  });

  it("replays the same key and command: the same result, no new rows, no new audit", async () => {
    const tenancy = harness.compose();
    const user = await tenancy.registeredUser("replay-owner");
    const key = harness.world().ids.newId("IdempotencyKey");
    const first = await tenancy.create(user, { idempotencyKey: key });
    const second = await tenancy.create(user, { idempotencyKey: key });

    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(await counts()).toEqual(oneBusiness);
  });

  it("rejects the same key with a different command as IDEMPOTENCY_KEY_REUSED, with no effect", async () => {
    const tenancy = harness.compose();
    const user = await tenancy.registeredUser("reuse-owner");
    const key = harness.world().ids.newId("IdempotencyKey");
    await tenancy.create(user, { idempotencyKey: key, name: "First Name" });
    await expect(tenancy.create(user, { idempotencyKey: key, name: "Other Name" })).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
    expect(await counts()).toEqual(oneBusiness);
  });

  it("another user's identical key is a different scope and creates a second business", async () => {
    const tenancy = harness.compose();
    const first = await tenancy.registeredUser("first-owner");
    const second = await tenancy.registeredUser("second-owner");
    const key = harness.world().ids.newId("IdempotencyKey");
    const a = await tenancy.create(first, { idempotencyKey: key });
    const b = await tenancy.create(second, { idempotencyKey: key });
    expect(b.replayed).toBe(false);
    expect(b.result.business.id).not.toBe(a.result.business.id);
  });

  it("rolls everything back when a later step fails (test-only failing location decorator)", async () => {
    const failure = new Error("injected: location insert failed after writing");
    const failingLocations: LocationRepository = {
      ...harness.repositories.locations,
      async insert(scope, location) {
        await harness.repositories.locations.insert(scope, location);
        throw failure;
      },
    };
    const tenancy = harness.compose({ decorate: { locations: failingLocations } });
    const user = await tenancy.registeredUser("rollback-owner");
    await expect(tenancy.create(user)).rejects.toBe(failure);
    expect(await counts()).toEqual(nothingCreated);

    const retried = await harness.compose().create(user);
    expect(retried.replayed).toBe(false);
    expect(await counts()).toEqual(oneBusiness);
  });

  it("rolls everything back when the last audit record fails", async () => {
    const failure = new Error("injected: membership audit failed");
    const failingAudit: AuditWriter = {
      ...harness.repositories.auditWriter,
      async recordBusinessEvent(scope, record) {
        if (record.action === "membership.created") throw failure;
        await harness.repositories.auditWriter.recordBusinessEvent(scope, record);
      },
    };
    const tenancy = harness.compose({ decorate: { auditWriter: failingAudit } });
    const user = await tenancy.registeredUser("audit-rollback-owner");
    await expect(tenancy.create(user)).rejects.toBe(failure);
    expect(await counts()).toEqual(nothingCreated);
  });

  it("rejects a currency missing from the reference data, leaving nothing behind", async () => {
    const tenancy = harness.compose();
    const user = await tenancy.registeredUser("usd-owner");
    await expect(tenancy.create(user, { currencyCode: "USD" })).rejects.toBeInstanceOf(ValidationError);
    expect(await counts()).toEqual(nothingCreated);
  });

  describe("concurrent requests with the same key", () => {
    it("create exactly one business; the other request replays it (no raw uniqueness error)", async () => {
      const tenancy = harness.compose();
      const user = await tenancy.registeredUser("race-owner");
      for (let round = 0; round < 5; round += 1) {
        const key = harness.world().ids.newId("IdempotencyKey");
        const outcomes = await Promise.all([
          tenancy.create(user, { idempotencyKey: key, name: `Race ${round}` }),
          tenancy.create(user, { idempotencyKey: key, name: `Race ${round}` }),
        ]);
        expect(outcomes.map((outcome) => outcome.replayed).sort()).toEqual([false, true]);
        expect(outcomes[0].result.business.id).toBe(outcomes[1].result.business.id);
      }
      expect(await counts()).toEqual({ businesses: 5, locations: 5, memberships: 5, audit: 15, idempotency: 5 });
    });

    it("waits for the first request: replay after it commits, IDEMPOTENCY_IN_PROGRESS past lock_timeout", async () => {
      const applied = gate();
      const release = gate();
      const holdingAudit: AuditWriter = {
        ...harness.repositories.auditWriter,
        async recordBusinessEvent(scope, record) {
          await harness.repositories.auditWriter.recordBusinessEvent(scope, record);
          if (record.action === "membership.created") {
            applied.open();
            await release.opened;
          }
        },
      };
      const holder = harness.compose({ decorate: { auditWriter: holdingAudit } });
      const impatient = harness.compose({ unitOfWork: harness.unitOfWorkWith({ lockTimeoutMs: 200 }) });
      const user = await holder.registeredUser("held-owner");
      const key = harness.world().ids.newId("IdempotencyKey");

      const first = holder.create(user, { idempotencyKey: key });
      await applied.opened;
      const startedAt = performance.now();
      await expect(impatient.create(user, { idempotencyKey: key })).rejects.toBeInstanceOf(IdempotencyInProgressError);
      expect(performance.now() - startedAt).toBeLessThan(2_000);

      const patient = harness.compose().create(user, { idempotencyKey: key });
      release.open();
      const [committed, replayed] = await Promise.all([first, patient]);
      expect(committed.replayed).toBe(false);
      expect(replayed.replayed).toBe(true);
      expect(replayed.result).toEqual(committed.result);
      expect(await counts()).toEqual(oneBusiness);
    });

    it("the same key with a different command, concurrently, is IDEMPOTENCY_KEY_REUSED for the loser", async () => {
      const applied = gate();
      const release = gate();
      const holdingAudit: AuditWriter = {
        ...harness.repositories.auditWriter,
        async recordBusinessEvent(scope, record) {
          await harness.repositories.auditWriter.recordBusinessEvent(scope, record);
          if (record.action === "membership.created") {
            applied.open();
            await release.opened;
          }
        },
      };
      const holder = harness.compose({ decorate: { auditWriter: holdingAudit } });
      const user = await holder.registeredUser("reuse-race-owner");
      const key = harness.world().ids.newId("IdempotencyKey");

      const first = holder.create(user, { idempotencyKey: key, name: "Original" });
      await applied.opened;
      const second = harness.compose().create(user, { idempotencyKey: key, name: "Different" });
      release.open();
      await expect(first).resolves.toMatchObject({ replayed: false });
      await expect(second).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
      expect(await counts()).toEqual(oneBusiness);
    });

    it("the waiting request runs as new when the first rolls back", async () => {
      const applied = gate();
      const release = gate();
      const failure = new Error("injected: first request fails after claiming the key");
      const failingAudit: AuditWriter = {
        ...harness.repositories.auditWriter,
        async recordBusinessEvent(scope, record) {
          await harness.repositories.auditWriter.recordBusinessEvent(scope, record);
          if (record.action === "membership.created") {
            applied.open();
            await release.opened;
            throw failure;
          }
        },
      };
      const failing = harness.compose({ decorate: { auditWriter: failingAudit } });
      const user = await failing.registeredUser("rolled-back-owner");
      const key = harness.world().ids.newId("IdempotencyKey");

      const first = failing.create(user, { idempotencyKey: key });
      await applied.opened;
      const second = harness.compose().create(user, { idempotencyKey: key });
      release.open();
      await expect(first).rejects.toBe(failure);
      await expect(second).resolves.toMatchObject({ replayed: false });
      expect(await counts()).toEqual(oneBusiness);
    });
  });
});
