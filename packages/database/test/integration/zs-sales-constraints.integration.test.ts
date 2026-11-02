import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type InventoryTenant, insertRow, inventoryPack, inventoryTenant, violation } from "../support/inventory.js";
import { appPool } from "../support/pg.js";
import { pricedProduct, reversalInput, type SaleProduct, saleInput, saleLine } from "../support/sales.js";
import { useTenancyHarness } from "../support/tenancy.js";

const CHECK = "23514";
const UNIQUE = "23505";
const FOREIGN_KEY = "23503";
const DENIED = "42501";

type Row = Record<string, unknown>;

/**
 * ZS. The Build 3 S5 sales schema against the migrated test database: every
 * sale, line, tender and receipt-counter CHECK, the SALE movement and sale
 * journal rules, the composite same-business FKs (two of them narrowly
 * deferred), and the application role's privileges. Rows are written as the
 * owner, copied from a sale recorded through the application and changed in
 * one column, so the constraint under test is the one that fails; privileges
 * are probed as the application role.
 */
describe("ZS. sales constraints and privileges (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const app = appPool();
  afterAll(() => app.end());

  let a: InventoryTenant;
  let b: InventoryTenant;
  let soap: SaleProduct;
  let bSoap: SaleProduct;
  let saleA: Row;
  let lineA: Row;
  let tenderA: Row;
  let movementA: Row;
  let journalA: Row;
  let saleB: Row;
  let receipt = 900_000;

  const newId = () => harness.world().ids.newId("Row");
  const jsonRow = async (sql: string, params: readonly unknown[]): Promise<Row> => {
    const { rows } = await harness.owner.query<{ row: Row }>(sql, [...params]);
    const row = rows[0]?.row;
    if (row === undefined) throw new Error("expected one row");
    return row;
  };
  const insert = (table: string, row: Row, client: pg.Pool | pg.PoolClient = harness.owner) =>
    insertRow(client, table, row);
  async function rejects(table: string, row: Row, code: string, constraint: string | RegExp) {
    const failure = await violation(insert(table, row));
    expect({ table, code: failure.code }).toEqual({ table, code });
    if (typeof constraint === "string") expect(failure.constraint).toBe(constraint);
    else expect(failure.constraint).toMatch(constraint);
  }

  /** A copy of A's sale header with a new identity and receipt number. */
  const header = (extra: Row = {}): Row => {
    receipt += 1;
    return { ...saleA, id: newId(), receipt_number: `S-${receipt}`, ...extra };
  };
  /** A copy of A's line as an untracked line 2 (no movement, no cost). */
  const line = (extra: Row = {}): Row => ({
    ...lineA,
    line_number: 2,
    tracked: false,
    cost_status: "NOT_APPLICABLE",
    cost_minor: null,
    valuation_version_read: null,
    movement_id: null,
    ...extra,
  });
  const tender = (extra: Row = {}): Row => ({ ...tenderA, tender_number: 2, ...extra });
  let version = 1000;
  const movement = (extra: Row = {}): Row => {
    version += 1;
    return { ...movementA, id: newId(), balance_version: version, ...extra };
  };
  const journal = (extra: Row = {}): Row => ({ ...journalA, id: newId(), ...extra });

  beforeEach(async () => {
    const tenancy = harness.compose();
    a = await inventoryTenant(harness, "sales-constraints-a");
    b = await inventoryTenant(harness, "sales-constraints-b");
    soap = await pricedProduct(harness, a, { name: "Soap", quantity: "10", totalCost: "35000" });
    bSoap = await pricedProduct(harness, b, { name: "Soap", quantity: "10", totalCost: "35000" });
    const soldA = await tenancy.recordSale.execute(a.context, saleInput(harness, [saleLine(soap, "2")], "100000"));
    const soldB = await tenancy.recordSale.execute(b.context, saleInput(harness, [saleLine(bSoap, "1")], "50000"));
    const idA = soldA.sale.saleId;
    saleA = await jsonRow(`SELECT to_jsonb(t) AS row FROM sales t WHERE id = $1`, [idA]);
    saleB = await jsonRow(`SELECT to_jsonb(t) AS row FROM sales t WHERE id = $1`, [soldB.sale.saleId]);
    lineA = await jsonRow(`SELECT to_jsonb(t) AS row FROM sale_lines t WHERE sale_id = $1`, [idA]);
    tenderA = await jsonRow(`SELECT to_jsonb(t) AS row FROM sale_tenders t WHERE sale_id = $1`, [idA]);
    movementA = await jsonRow(`SELECT to_jsonb(t) AS row FROM inventory_movements t WHERE sale_id = $1`, [idA]);
    journalA = await jsonRow(`SELECT to_jsonb(t) AS row FROM journal_entries t WHERE sale_id = $1`, [idA]);
  });

  describe("sales", () => {
    it("rejects every invalid header shape with its CHECK (23514)", async () => {
      const probes: [Row, string | RegExp][] = [
        [{ status: "VOID" }, /^sales_(status_valid|reversal_shape)$/],
        [{ receipt_number: "X-1" }, "sales_receipt_number_format"],
        [{ gross_total_minor: 0 }, "sales_gross_total_positive"],
        [{ discount_total_minor: -1 }, "sales_discount_total_non_negative"],
        [{ tax_total_minor: -1 }, "sales_tax_total_non_negative"],
        [{ total_minor: 0 }, "sales_total_positive"],
        [{ cost_status: "MIXED" }, "sales_cost_status_valid"],
        [{ cogs_total_minor: -1 }, "sales_cogs_total_non_negative"],
        [{ source_channel: "fax" }, "sales_source_channel_valid"],
        [{ correlation_id: "has space" }, "sales_correlation_id_format"],
        [{ recorded_at: "2000-01-01T00:00:00Z" }, "sales_recorded_after_occurred"],
        [{ reversal_reason: " padded " }, /^sales_(reversal_reason_valid|reversal_shape)$/],
        [
          {
            status: "REVERSED",
            reversed_at: saleA["recorded_at"],
            reversed_by_membership_id: a.membershipId,
            reversal_reason: "Wrong item",
            reversal_journal_entry_id: saleA["journal_entry_id"],
            reversal_tender_unwound_confirmed: true,
          },
          "sales_reversal_journal_distinct",
        ],
        [
          {
            status: "REVERSED",
            reversed_at: saleA["recorded_at"],
            reversed_by_membership_id: a.membershipId,
            reversal_reason: "Wrong item",
            reversal_journal_entry_id: newId(),
            reversal_tender_unwound_confirmed: false,
          },
          "sales_reversal_shape",
        ],
        [{ status: "REVERSED" }, "sales_reversal_shape"],
      ];
      for (const [extra, constraint] of probes) await rejects("sales", header(extra), CHECK, constraint);
    });

    it("receipt numbers are unique per business, and the same number is free in another business", async () => {
      await rejects(
        "sales",
        header({ receipt_number: saleA["receipt_number"] }),
        UNIQUE,
        "sales_business_id_receipt_number_key",
      );
      expect(saleA["receipt_number"]).toBe("S-000001");
      expect(saleB["receipt_number"]).toBe("S-000001");
    });

    it("a header can only reference its own business's currency, location, members and devices (23503)", async () => {
      const probes: [Row, string][] = [
        [{ currency: "USD" }, "sales_business_id_currency_fkey"],
        [{ location_id: b.locationId }, "sales_business_id_location_id_fkey"],
        [{ recorded_by_membership_id: b.membershipId }, "sales_business_id_recorded_by_membership_id_fkey"],
        [{ device_id: newId() }, "sales_business_id_device_id_fkey"],
      ];
      for (const [extra, constraint] of probes) await rejects("sales", header(extra), FOREIGN_KEY, constraint);

      await harness.compose().reverseSale.execute(a.context, reversalInput(harness, String(saleA["id"])));
      const reversedBy = await violation(
        harness.owner.query(`UPDATE sales SET reversed_by_membership_id = $2 WHERE id = $1`, [
          saleA["id"],
          b.membershipId,
        ]),
      );
      expect(reversedBy).toEqual({
        code: FOREIGN_KEY,
        constraint: "sales_business_id_reversed_by_membership_id_fkey",
      });
      const foreignJournal = await violation(
        harness.owner.query(`UPDATE sales SET reversal_journal_entry_id = $2 WHERE id = $1`, [
          saleA["id"],
          saleB["journal_entry_id"],
        ]),
      );
      expect(foreignJournal).toEqual({ code: FOREIGN_KEY, constraint: "sales_reversal_journal_fkey" });
    });

    it("a header without its original journal fails at commit on the deferred journal FK", async () => {
      await rejects("sales", header({ journal_entry_id: newId() }), FOREIGN_KEY, "sales_original_journal_fkey");
    });

    it("the receipt counter starts at 1 or above", async () => {
      await harness.owner.query(`DELETE FROM sale_receipt_sequences WHERE business_id = $1`, [b.businessId]);
      await rejects(
        "sale_receipt_sequences",
        { business_id: b.businessId, next_number: 0, updated_at: saleA["recorded_at"] },
        CHECK,
        "sale_receipt_sequences_next_number_positive",
      );
    });
  });

  describe("lines and tenders", () => {
    it("rejects every invalid line shape with its CHECK (23514)", async () => {
      const gross = Number(lineA["gross_minor"]);
      const probes: [Row, string | RegExp][] = [
        [{ line_number: 0 }, "sale_lines_line_number_range"],
        [{ line_number: 201 }, "sale_lines_line_number_range"],
        [{ product_name: " Soap" }, "sale_lines_product_name_valid"],
        [{ sku: "" }, "sale_lines_sku_valid"],
        [{ quantity_minor: 0 }, "sale_lines_quantity_positive"],
        [{ unit_scale: 4 }, "sale_lines_unit_scale_range"],
        [{ unit_price_minor: 0 }, "sale_lines_unit_price_positive"],
        [{ price_version: 0 }, "sale_lines_price_version_positive"],
        [{ gross_minor: 0 }, /^sale_lines_(gross_positive|discount_range)$/],
        [{ discount_kind: "FIXED", discount_value: gross, discount_minor: gross }, "sale_lines_discount_range"],
        [{ discount_value: 5 }, "sale_lines_discount_shape"],
        [{ discount_kind: "BASIS_POINTS", discount_value: 10_000 }, "sale_lines_discount_shape"],
        [{ net_minor: 0, taxable_base_minor: 0 }, "sale_lines_net_positive"],
        [{ total_minor: 0 }, "sale_lines_total_positive"],
        [{ tax_kind: "VAT" }, "sale_lines_tax_kind_valid"],
        [{ tax_name: "VAT" }, "sale_lines_tax_none_shape"],
        [{ tax_minor: 1 }, "sale_lines_tax_none_shape"],
        [{ tax_kind: "STANDARD", tax_minor: -1 }, "sale_lines_tax_non_negative"],
        [{ tax_kind: "STANDARD", taxable_base_minor: -1 }, "sale_lines_taxable_base_non_negative"],
        [{ tax_kind: "STANDARD", tax_name: " VAT" }, "sale_lines_tax_name_valid"],
        [{ tax_kind: "STANDARD", tax_rate_bps: 10_001 }, "sale_lines_tax_rate_range"],
        [{ tax_kind: "STANDARD", tax_pricing_mode: "MIXED" }, "sale_lines_tax_pricing_mode_valid"],
        [{ tax_kind: "STANDARD", tax_rounding_mode: "half_even" }, "sale_lines_tax_rounding_mode_format"],
        [{ cost_status: "PARTIAL" }, /^sale_lines_cost_(status_valid|shape)$/],
        [{ tracked: true }, "sale_lines_cost_shape"],
        [{ cost_minor: 5 }, "sale_lines_cost_shape"],
        [
          { tracked: true, cost_status: "VALUED", valuation_version_read: 1, movement_id: newId() },
          "sale_lines_cost_shape",
        ],
        [
          { tracked: true, cost_status: "UNVALUED", cost_minor: 5, valuation_version_read: 1, movement_id: newId() },
          "sale_lines_cost_shape",
        ],
      ];
      for (const [extra, constraint] of probes) await rejects("sale_lines", line(extra), CHECK, constraint);
    });

    it("rejects every invalid tender shape with its CHECK (23514)", async () => {
      const probes: [Row, string | RegExp][] = [
        [{ tender_number: 0 }, "sale_tenders_tender_number_range"],
        [{ tender_number: 11 }, "sale_tenders_tender_number_range"],
        [{ method: "CHEQUE" }, /^sale_tenders_(method_valid|cash_shape)$/],
        [{ amount_minor: 0 }, "sale_tenders_amount_positive"],
        [{ reference: " ref" }, "sale_tenders_reference_valid"],
        [{ verification_status: "VERIFIED" }, /^sale_tenders_(verification_status_valid|cash_shape)$/],
        [{ verification_status: "NOT_VERIFIED" }, "sale_tenders_cash_shape"],
        [{ method: "BANK_TRANSFER" }, "sale_tenders_cash_shape"],
        [{ cash_received_minor: 1, change_given_minor: 0 }, "sale_tenders_cash_shape"],
        [{ cash_received_minor: tenderA["amount_minor"], change_given_minor: null }, "sale_tenders_cash_shape"],
        [
          { method: "POS_CARD", verification_status: "NOT_VERIFIED", cash_received_minor: 1, change_given_minor: 0 },
          "sale_tenders_cash_shape",
        ],
      ];
      for (const [extra, constraint] of probes) await rejects("sale_tenders", tender(extra), CHECK, constraint);
    });

    it("lines and tenders reference their own business's sale and variant; a line's movement is checked at commit", async () => {
      await rejects(
        "sale_lines",
        line({ variant_id: bSoap.variantId }),
        FOREIGN_KEY,
        "sale_lines_business_id_variant_id_fkey",
      );
      await rejects("sale_lines", line({ sale_id: saleB["id"] }), FOREIGN_KEY, "sale_lines_business_id_sale_id_fkey");
      await rejects("sale_lines", line({ unit: "CRATE" }), FOREIGN_KEY, "sale_lines_unit_fkey");
      await rejects(
        "sale_tenders",
        tender({ sale_id: saleB["id"] }),
        FOREIGN_KEY,
        "sale_tenders_business_id_sale_id_fkey",
      );
      await rejects(
        "sale_lines",
        line({ tracked: true, cost_status: "UNVALUED", valuation_version_read: 1, movement_id: newId() }),
        FOREIGN_KEY,
        "sale_lines_movement_fkey",
      );
      await rejects(
        "sale_lines",
        line({
          tracked: true,
          cost_status: "VALUED",
          cost_minor: 0,
          valuation_version_read: 1,
          movement_id: lineA["movement_id"],
        }),
        UNIQUE,
        "sale_lines_business_id_movement_id_key",
      );
    });
  });

  describe("SALE movements and sale journals", () => {
    it("a SALE movement is sale-sourced, negative when original, positive when reversing, and never has a reason or a pack", async () => {
      const pack = await inventoryPack(harness, soap.product.variant, "Carton", 2n);
      const opening = await harness.owner.query<{ id: string }>(
        `SELECT id::text FROM inventory_opening_batches WHERE business_id = $1`,
        [a.businessId],
      );
      const probes: [Row, string | RegExp][] = [
        [{ quantity_delta_minor: 2 }, "inventory_movements_direction"],
        [{ reverses_movement_id: movementA["id"], reason_note: "Returned" }, "inventory_movements_direction"],
        [{ reason_code: "DAMAGED" }, "inventory_movements_reason_shape"],
        [{ reason_note: "Returned" }, "inventory_movements_reason_shape"],
        [
          { reverses_movement_id: movementA["id"], quantity_delta_minor: 2, reason_code: "DAMAGED", reason_note: "x" },
          "inventory_movements_reason_shape",
        ],
        [{ sale_id: null, opening_batch_id: opening.rows[0]?.id }, /^inventory_movements_(sale|opening)_source$/],
        [{ sale_id: null }, /^inventory_movements_(sale_source|one_source)$/],
        [{ opening_batch_id: opening.rows[0]?.id }, /^inventory_movements_(one|opening)_source$/],
        [
          { pack_id: pack.id, pack_name: "Carton", pack_factor_minor: 2, pack_count: 1 },
          "inventory_movements_sale_no_pack",
        ],
      ];
      for (const [extra, constraint] of probes)
        await rejects("inventory_movements", movement(extra), CHECK, constraint);
      await rejects(
        "inventory_movements",
        movement({ type: "ADJUSTMENT", quantity_delta_minor: 1, reason_code: "FOUND_STOCK" }),
        CHECK,
        /^inventory_movements_(sale_source|adjustment_source|one_source)$/,
      );
    });

    it("a SALE movement can only reference a sale of its own business and location", async () => {
      await rejects(
        "inventory_movements",
        movement({ sale_id: saleB["id"] }),
        FOREIGN_KEY,
        "inventory_movements_business_id_sale_id_location_id_fkey",
      );
    });

    it("a sale journal has exactly one typed source, a location, one ORIGINAL per sale, and its own business's sale", async () => {
      const valuation = { valuation_id: newId() };
      await rejects("journal_entries", journal(valuation), CHECK, "journal_entries_one_source");
      await rejects("journal_entries", journal({ location_id: null }), CHECK, "journal_entries_sale_location");
      await rejects("journal_entries", journal(), UNIQUE, "journal_entries_original_sale_key");
      await rejects(
        "journal_entries",
        journal({ sale_id: saleB["id"] }),
        FOREIGN_KEY,
        "journal_entries_business_id_sale_id_location_id_fkey",
      );
    });
  });

  describe("application role privileges", () => {
    it("sales are append-only except the reversal columns; lines and tenders are append-only; the counter only moves", async () => {
      const allowed = [
        `UPDATE sales SET status = status, reversed_at = reversed_at, reversed_by_membership_id = reversed_by_membership_id,
           reversal_reason = reversal_reason, reversal_journal_entry_id = reversal_journal_entry_id,
           reversal_tender_unwound_confirmed = reversal_tender_unwound_confirmed WHERE false`,
        `UPDATE sale_receipt_sequences SET next_number = next_number, updated_at = updated_at WHERE false`,
        `SELECT 1 FROM sales s JOIN sale_lines l USING (business_id) JOIN sale_tenders t USING (business_id) LIMIT 1`,
      ];
      for (const sql of allowed) await app.query(sql);
      const denied = [
        `UPDATE sales SET total_minor = total_minor WHERE false`,
        `UPDATE sales SET journal_entry_id = journal_entry_id WHERE false`,
        `UPDATE sales SET receipt_number = receipt_number WHERE false`,
        `DELETE FROM sales WHERE false`,
        `TRUNCATE sales`,
        `UPDATE sale_lines SET cost_minor = cost_minor WHERE false`,
        `DELETE FROM sale_lines WHERE false`,
        `TRUNCATE sale_lines`,
        `UPDATE sale_tenders SET amount_minor = amount_minor WHERE false`,
        `DELETE FROM sale_tenders WHERE false`,
        `UPDATE sale_receipt_sequences SET business_id = business_id WHERE false`,
        `DELETE FROM sale_receipt_sequences WHERE false`,
        `UPDATE inventory_movements SET sale_id = sale_id WHERE false`,
        `UPDATE journal_entries SET sale_id = sale_id WHERE false`,
      ];
      for (const sql of denied) {
        const failure = await violation(app.query(sql));
        expect({ sql, code: failure.code }).toEqual({ sql, code: DENIED });
      }
    });

    it("grants exactly SELECT and INSERT on the four tables, the listed column UPDATEs, and nothing to PUBLIC", async () => {
      const tables = await harness.owner.query<{ table_name: string; privilege_type: string; grantee: string }>(
        `SELECT table_name, privilege_type, grantee FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND grantee IN ('tali_app', 'PUBLIC')
           AND table_name IN ('sales', 'sale_lines', 'sale_tenders', 'sale_receipt_sequences')
         ORDER BY table_name, privilege_type`,
      );
      expect(tables.rows).toEqual(
        ["sale_lines", "sale_receipt_sequences", "sale_tenders", "sales"].flatMap((table_name) =>
          ["INSERT", "SELECT"].map((privilege_type) => ({ table_name, privilege_type, grantee: "tali_app" })),
        ),
      );
      const columns = await harness.owner.query<{ table_name: string; column_name: string; grantee: string }>(
        `SELECT table_name, column_name, grantee FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND privilege_type = 'UPDATE' AND grantee IN ('tali_app', 'PUBLIC')
           AND table_name IN ('sales', 'sale_lines', 'sale_tenders', 'sale_receipt_sequences')
         ORDER BY table_name, column_name`,
      );
      expect(columns.rows).toEqual([
        { table_name: "sale_receipt_sequences", column_name: "next_number", grantee: "tali_app" },
        { table_name: "sale_receipt_sequences", column_name: "updated_at", grantee: "tali_app" },
        ...[
          "reversal_journal_entry_id",
          "reversal_reason",
          "reversal_tender_unwound_confirmed",
          "reversed_at",
          "reversed_by_membership_id",
          "status",
        ].map((column_name) => ({ table_name: "sales", column_name, grantee: "tali_app" })),
      ]);
    });
  });
});
