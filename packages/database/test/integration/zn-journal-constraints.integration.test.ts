import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inventoryProduct, inventoryTenant } from "../support/inventory.js";
import { appPool, sqlState } from "../support/pg.js";
import { useTenancyHarness } from "../support/tenancy.js";

const CHECK = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";
const INSERT_ONLY = ["journal_entries", "journal_lines", "inventory_movement_valuations", "stock_valuations"] as const;

/**
 * ZN. Journal and valuation schema constraints and application-role grants
 * (ADR-009 sections 11 and 13): SELECT+INSERT on journals and facts; column
 * UPDATE only on inventory_valuations projection columns; no DELETE/TRUNCATE;
 * exactly one typed source.
 */
describe("ZN. journal and valuation constraints and privileges (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const app = appPool();
  afterAll(() => app.end());

  let businessId: string;
  let membershipId: string;
  let locationId: string;
  let openingBatchId: string;

  beforeEach(async () => {
    const tenancy = harness.compose();
    const t = await inventoryTenant(harness, "journal-constraints");
    const soap = await inventoryProduct(harness, t, { name: "Soap" });
    const opening = await tenancy.recordOpeningStock.execute(t.context, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "3", unit: "PIECE" }],
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
    businessId = t.businessId;
    membershipId = t.membershipId;
    locationId = t.locationId;
    openingBatchId = opening.document.id;
  });

  it.each(INSERT_ONLY)("%s: UPDATE, DELETE and TRUNCATE are denied", async (table) => {
    expect(await sqlState(app.query(`UPDATE ${table} SET business_id = business_id`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(app.query(`DELETE FROM ${table}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(app.query(`TRUNCATE ${table}`))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("inventory_valuations may UPDATE projection columns but not the cutover watermark", async () => {
    expect(await sqlState(app.query(`DELETE FROM inventory_valuations`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(app.query(`TRUNCATE inventory_valuations`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(app.query(`UPDATE inventory_valuations SET started_from_balance_version = 0`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it("holds SELECT and INSERT on journal tables, with no PUBLIC grants", async () => {
    for (const table of ["journal_entries", "journal_lines"] as const) {
      const grants = await harness.owner.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = $1 AND grantee = 'tali_app'
         ORDER BY privilege_type`,
        [table],
      );
      expect(grants.rows.map((row) => row.privilege_type)).toEqual(["INSERT", "SELECT"]);
      const publicGrants = await harness.owner.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = $1 AND grantee = 'PUBLIC'`,
        [table],
      );
      expect(publicGrants.rows).toEqual([]);
    }
  });

  it("rejects a journal entry with no typed source", async () => {
    const id = harness.world().ids.newId("JournalEntry");
    const at = "2026-10-18T08:00:00.000Z";
    expect(
      await sqlState(
        harness.owner.query(
          `INSERT INTO journal_entries (
             business_id, id, currency, occurred_at, business_date, recorded_at, entry_kind,
             posting_rule, posting_rule_version, description, actor_membership_id, location_id,
             source_channel, correlation_id
           ) VALUES ($1, $2, 'NGN', $3, '2026-10-18', $3, 'ORIGINAL',
             'OPENING_STOCK_POSTED', 1, 'missing source', $4, $5, 'web', 'zn-check')`,
          [businessId, id, at, membershipId, locationId],
        ),
      ),
    ).toBe(CHECK);
  });

  it("rejects a journal entry with two typed sources", async () => {
    const id = harness.world().ids.newId("JournalEntry");
    const valuationId = harness.world().ids.newId("StockValuation");
    const at = "2026-10-18T08:00:00.000Z";
    expect(
      await sqlState(
        harness.owner.query(
          `INSERT INTO journal_entries (
             business_id, id, currency, occurred_at, business_date, recorded_at, entry_kind,
             opening_batch_id, valuation_id, posting_rule, posting_rule_version, description,
             actor_membership_id, location_id, source_channel, correlation_id
           ) VALUES ($1, $2, 'NGN', $3, '2026-10-18', $3, 'ORIGINAL',
             $4, $5, 'OPENING_STOCK_POSTED', 1, 'two sources', $6, $7, 'web', 'zn-two')`,
          [businessId, id, at, openingBatchId, valuationId, membershipId, locationId],
        ),
      ),
    ).toBe(CHECK);
  });

  it("inserts stock_valuations and journal_entries in one transaction using deferred cyclic FKs, without updating ids", async () => {
    const variant = await harness.owner.query<{ variant_id: string; currency: string }>(
      `SELECT m.variant_id::text, b.currency_code AS currency
       FROM inventory_movements m JOIN businesses b ON b.id = m.business_id
       WHERE m.business_id = $1 LIMIT 1`,
      [businessId],
    );
    const variantId = variant.rows[0]?.variant_id;
    const valuationId = harness.world().ids.newId("StockValuation");
    const entryId = harness.world().ids.newId("JournalEntry");
    const at = "2026-10-18T10:00:00.000Z";
    const client = await harness.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO stock_valuations (
           business_id, id, location_id, variant_id, kind, quantity_at_valuation_minor, balance_version_at_valuation,
           previous_value_minor, new_value_minor, currency, reason, journal_entry_id, actor_membership_id,
           source_channel, correlation_id, occurred_at, business_date, recorded_at
         ) VALUES ($1, $2, $3, $4, 'INITIAL_OPENING', 3, 1, 0, 10, 'NGN', 'deferred fk', $5, $6,
           'web', 'zn-deferred', $7, '2026-10-18', $7)`,
        [businessId, valuationId, locationId, variantId, entryId, membershipId, at],
      );
      await client.query(
        `INSERT INTO journal_entries (
           business_id, id, currency, occurred_at, business_date, recorded_at, entry_kind,
           valuation_id, posting_rule, posting_rule_version, description,
           actor_membership_id, location_id, source_channel, correlation_id
         ) VALUES ($1, $2, 'NGN', $3, '2026-10-18', $3, 'ORIGINAL',
           $4, 'INITIAL_OPENING_VALUATION', 1, 'deferred fk', $5, $6, 'web', 'zn-deferred')`,
        [businessId, entryId, at, valuationId, membershipId, locationId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const stored = await harness.owner.query(
      `SELECT s.id::text AS valuation, s.journal_entry_id::text AS journal, e.valuation_id::text AS entry_valuation
       FROM stock_valuations s JOIN journal_entries e ON e.id = s.journal_entry_id
       WHERE s.id = $1`,
      [valuationId],
    );
    expect(stored.rows[0]).toEqual({ valuation: valuationId, journal: entryId, entry_valuation: valuationId });

    const orphanValuation = harness.world().ids.newId("StockValuation");
    const missingJournal = harness.world().ids.newId("JournalEntry");
    const failed = await harness.owner.connect();
    let failedCommit = false;
    try {
      await failed.query("BEGIN");
      await failed.query(
        `INSERT INTO stock_valuations (
           business_id, id, location_id, variant_id, kind, quantity_at_valuation_minor, balance_version_at_valuation,
           previous_value_minor, new_value_minor, currency, reason, journal_entry_id, actor_membership_id,
           source_channel, correlation_id, occurred_at, business_date, recorded_at
         ) VALUES ($1, $2, $3, $4, 'INITIAL_OPENING', 3, 1, 0, 11, 'NGN', 'unresolved fk', $5, $6,
           'web', 'zn-unresolved', $7, '2026-10-18', $7)`,
        [businessId, orphanValuation, locationId, variantId, missingJournal, membershipId, at],
      );
      await failed.query("COMMIT");
    } catch {
      failedCommit = true;
      await failed.query("ROLLBACK").catch(() => undefined);
    } finally {
      failed.release();
    }
    expect(failedCommit).toBe(true);
  });

  it("rejects malformed residual rows and unpaired negative movement value_after", async () => {
    const tenancy = harness.compose();
    const t = await inventoryTenant(harness, "residual-constraints");
    const soap = await inventoryProduct(harness, t, { name: "Soap" });
    const oil = await inventoryProduct(harness, t, { name: "Oil" });
    await tenancy.recordOpeningStock.execute(t.context, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "10",
          unit: "PIECE",
          totalCost: { amountMinor: "1000", currency: "NGN" },
        },
      ],
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
    await tenancy.recordOpeningStock.execute(t.context, {
      lines: [{ variantId: oil.variant.id, quantityMinor: "2", unit: "PIECE" }],
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
    const receipt = await tenancy.postGoodsReceipt.execute(t.context, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "10",
          unit: "PIECE",
          totalCost: { amountMinor: "500", currency: "NGN" },
        },
      ],
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
    await tenancy.reverseGoodsReceipt.execute(t.context, {
      documentId: receipt.document.id,
      reason: "Returned the delivery",
    });
    const trigger = await harness.owner.query<{ id: string; location_id: string }>(
      `SELECT id::text, location_id::text FROM inventory_movements
       WHERE business_id = $1 AND reverses_movement_id IS NOT NULL LIMIT 1`,
      [t.businessId],
    );
    const triggerId = trigger.rows[0]?.id;
    const locationId = trigger.rows[0]?.location_id;
    const at = "2026-10-30T08:00:00.000Z";
    const residualCols = `business_id, id, location_id, variant_id, kind, trigger_movement_id,
      quantity_at_valuation_minor, balance_version_at_valuation, previous_value_minor, new_value_minor,
      currency, reason, actor_membership_id, source_channel, correlation_id, occurred_at, business_date, recorded_at`;

    expect(
      await sqlState(
        harness.owner.query(
          `INSERT INTO stock_valuations (${residualCols})
           VALUES ($1, $2, $3, $4, 'REVERSAL_RESIDUAL', NULL, 0, 1, -1, 0, 'NGN', 'no trigger', $5,
             'web', 'zn-no-trigger', $6, '2026-10-30', $6)`,
          [t.businessId, harness.world().ids.newId("StockValuation"), locationId, soap.variant.id, t.membershipId, at],
        ),
      ),
    ).toBe(CHECK);

    expect(
      await sqlState(
        harness.owner.query(
          `INSERT INTO stock_valuations (${residualCols})
           VALUES ($1, $2, $3, $4, 'INITIAL_OPENING', $5, 0, 1, 0, 0, 'NGN', 'opening trigger', $6,
             'web', 'zn-opening-trigger', $7, '2026-10-30', $7)`,
          [
            t.businessId,
            harness.world().ids.newId("StockValuation"),
            locationId,
            soap.variant.id,
            triggerId,
            t.membershipId,
            at,
          ],
        ),
      ),
    ).toBe(CHECK);

    expect(
      await sqlState(
        harness.owner.query(
          `INSERT INTO stock_valuations (${residualCols})
           VALUES ($1, $2, $3, $4, 'OPERATIONAL', $5, 0, 1, 0, 0, 'NGN', 'operational trigger', $6,
             'web', 'zn-op-trigger', $7, '2026-10-30', $7)`,
          [
            t.businessId,
            harness.world().ids.newId("StockValuation"),
            locationId,
            soap.variant.id,
            triggerId,
            t.membershipId,
            at,
          ],
        ),
      ),
    ).toBe(CHECK);

    await harness.owner.query(
      `INSERT INTO stock_valuations (${residualCols})
       VALUES ($1, $2, $3, $4, 'REVERSAL_RESIDUAL', $5, 0, 1, -1, 0, 'NGN', 'first residual', $6,
         'web', 'zn-first-residual', $7, '2026-10-30', $7)`,
      [
        t.businessId,
        harness.world().ids.newId("StockValuation"),
        locationId,
        soap.variant.id,
        triggerId,
        t.membershipId,
        at,
      ],
    );
    expect(
      await sqlState(
        harness.owner.query(
          `INSERT INTO stock_valuations (${residualCols})
           VALUES ($1, $2, $3, $4, 'REVERSAL_RESIDUAL', $5, 0, 1, -2, 0, 'NGN', 'duplicate residual', $6,
             'web', 'zn-dup-residual', $7, '2026-10-30', $7)`,
          [
            t.businessId,
            harness.world().ids.newId("StockValuation"),
            locationId,
            soap.variant.id,
            triggerId,
            t.membershipId,
            at,
          ],
        ),
      ),
    ).toBe("23505");

    const other = await inventoryTenant(harness, "residual-foreign");
    const otherSoap = await inventoryProduct(harness, other, { name: "Other soap" });
    expect(
      await sqlState(
        harness.owner.query(
          `INSERT INTO stock_valuations (${residualCols})
           VALUES ($1, $2, $3, $4, 'REVERSAL_RESIDUAL', $5, 0, 1, -1, 0, 'NGN', 'foreign trigger', $6,
             'web', 'zn-foreign-trigger', $7, '2026-10-30', $7)`,
          [
            other.businessId,
            harness.world().ids.newId("StockValuation"),
            other.locationId,
            otherSoap.variant.id,
            triggerId,
            other.membershipId,
            at,
          ],
        ),
      ),
    ).toBe("23503");

    const oilReceipt = await tenancy.postGoodsReceipt.execute(t.context, {
      lines: [{ variantId: oil.variant.id, quantityMinor: "1", unit: "PIECE" }],
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
    await tenancy.reverseGoodsReceipt.execute(t.context, {
      documentId: oilReceipt.document.id,
      reason: "Returned oil",
    });
    const oilTrigger = await harness.owner.query<{ id: string }>(
      `SELECT id::text FROM inventory_movements
       WHERE business_id = $1 AND variant_id = $2 AND reverses_movement_id IS NOT NULL`,
      [t.businessId, oil.variant.id],
    );
    expect(
      await sqlState(
        harness.owner.query(
          `INSERT INTO stock_valuations (${residualCols})
           VALUES ($1, $2, $3, $4, 'REVERSAL_RESIDUAL', $5, 0, 1, -1, 0, 'NGN', 'wrong variant', $6,
             'web', 'zn-wrong-variant', $7, '2026-10-30', $7)`,
          [
            t.businessId,
            harness.world().ids.newId("StockValuation"),
            locationId,
            soap.variant.id,
            oilTrigger.rows[0]?.id,
            t.membershipId,
            at,
          ],
        ),
      ),
    ).toBe("23503");

    expect(
      await sqlState(
        harness.owner.query(
          `UPDATE inventory_movement_valuations
           SET value_after_minor = -1, cost_basis = 'SUPPLIED_COST'
           WHERE business_id = $1 AND movement_id = $2`,
          [t.businessId, triggerId],
        ),
      ),
    ).toBe(CHECK);
    await harness.owner.query(
      `UPDATE inventory_movement_valuations
       SET value_after_minor = -1, cost_basis = 'REVERSAL_OF_ORIGINAL'
       WHERE business_id = $1 AND movement_id = $2`,
      [t.businessId, triggerId],
    );
  });
});
