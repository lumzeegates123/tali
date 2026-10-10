import type { LocationId, ProductPack, ProductVariantId } from "@tali/domain";
import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TENANCY_TABLES } from "../../src/testing/index.js";
import {
  type InventoryTenant,
  insertRow,
  inventoryPack,
  inventoryProduct,
  inventoryTenant,
  secondLocation,
  violation,
} from "../support/inventory.js";
import { appPool, sqlState } from "../support/pg.js";
import { useTenancyHarness } from "../support/tenancy.js";

const CHECK = "23514";
const FOREIGN_KEY = "23503";
const UNIQUE = "23505";
const INSUFFICIENT_PRIVILEGE = "42501";
const AT = "2026-10-01T08:00:00.000Z";
const LATER = "2026-10-01T09:00:00.000Z";
const EARLIER = "2026-10-01T07:00:00.000Z";
const BOUND = 1_000_000_000_000_000n;
const STOCKTAKE_LIFECYCLE_COLUMNS = [
  "status",
  "version",
  "posted_at",
  "posted_by_membership_id",
  "business_date",
  "cancelled_at",
  "cancelled_by_membership_id",
] as const;
const STOCKTAKE_IMMUTABLE_COLUMNS = [
  "business_id",
  "id",
  "location_id",
  "note",
  "created_by_membership_id",
  "created_at",
];
const LINE_COUNT_COLUMNS = [
  "status",
  "counted_quantity_minor",
  "stock_unit_code",
  "expected_at_count_minor",
  "balance_version_at_count",
  "version",
  "counted_by_membership_id",
  "counted_at",
  "variance_minor",
] as const;
const LINE_IDENTITY_COLUMNS = ["business_id", "stocktake_id", "variant_id"];

type Row = Record<string, unknown>;

/**
 * The Build 2 Slice 5 definitions of the four movement CHECKs the stocktake
 * migration replaced, as PostgreSQL renders them. The Slice 5 reason shape
 * accepted an original ADJUSTMENT or WRITE_OFF with a NULL reason code
 * (NULL IN (...) is UNKNOWN, which a CHECK accepts); the replacement rejects it.
 */
const ADJUSTMENT_CODES = "ARRAY['FOUND_STOCK'::text, 'DATA_ENTRY_CORRECTION'::text, 'OTHER'::text]";
const WRITE_OFF_CODES =
  "ARRAY['DAMAGED'::text, 'EXPIRED'::text, 'SPOILED'::text, 'THEFT_OR_LOSS'::text, 'OTHER'::text]";
const SLICE_5_REPLACED_CHECKS = {
  inventory_movements_type_valid:
    "((type = ANY (ARRAY['OPENING'::text, 'PURCHASE_RECEIPT'::text, 'ADJUSTMENT'::text, 'WRITE_OFF'::text])))",
  inventory_movements_one_source: "((num_nonnulls(opening_batch_id, goods_receipt_id, adjustment_id) = 1))",
  inventory_movements_direction:
    "((((type = 'OPENING'::text) AND (reverses_movement_id IS NULL) AND (quantity_delta_minor > 0)) OR ((type = 'PURCHASE_RECEIPT'::text) AND ((reverses_movement_id IS NULL) = (quantity_delta_minor > 0))) OR ((type = 'WRITE_OFF'::text) AND ((reverses_movement_id IS NULL) = (quantity_delta_minor < 0))) OR (type = 'ADJUSTMENT'::text)))",
  inventory_movements_reason_shape: `((((reverses_movement_id IS NULL) AND (type = ANY (ARRAY['OPENING'::text, 'PURCHASE_RECEIPT'::text])) AND (reason_code IS NULL) AND (reason_note IS NULL)) OR ((reverses_movement_id IS NULL) AND (type = 'ADJUSTMENT'::text) AND (reason_code = ANY (${ADJUSTMENT_CODES})) AND ((reason_code <> 'OTHER'::text) OR (reason_note IS NOT NULL))) OR ((reverses_movement_id IS NULL) AND (type = 'WRITE_OFF'::text) AND (reason_code = ANY (${WRITE_OFF_CODES})) AND ((reason_code <> 'OTHER'::text) OR (reason_note IS NOT NULL))) OR ((reverses_movement_id IS NOT NULL) AND (reason_code IS NULL) AND (reason_note IS NOT NULL))))`,
} as const;

/**
 * Every combination of the columns those CHECKs read, for the four Slice 5
 * types and an unknown one, with no stocktake reference: 5 types x 2 reversal
 * shapes x 2 directions x 9 reason codes (none, each listed code, an unknown
 * one) x 2 notes x 8 source combinations = 2880 rows.
 */
/** The Slice 5 gap the stocktake migration closes: an original ADJUSTMENT or WRITE_OFF with no reason code. */
const NULL_REASON_BUG = "reverses_movement_id IS NULL AND type IN ('ADJUSTMENT', 'WRITE_OFF') AND reason_code IS NULL";
const PROBE_UUID = "'00000000-0000-4000-8000-000000000001'::uuid";
const CHECK_GRID = `
  SELECT type, reverses_movement_id, quantity_delta_minor, reason_code, reason_note,
         opening_batch_id, goods_receipt_id, adjustment_id, NULL::uuid AS stocktake_id
  FROM unnest(ARRAY['OPENING', 'PURCHASE_RECEIPT', 'ADJUSTMENT', 'WRITE_OFF', 'SALE']) AS t(type)
  CROSS JOIN (VALUES (NULL::uuid), (${PROBE_UUID})) AS r(reverses_movement_id)
  CROSS JOIN (VALUES (-1::bigint), (1::bigint)) AS d(quantity_delta_minor)
  CROSS JOIN unnest(ARRAY[NULL, 'FOUND_STOCK', 'DATA_ENTRY_CORRECTION', 'OTHER', 'DAMAGED', 'EXPIRED', 'SPOILED',
                          'THEFT_OR_LOSS', 'UNKNOWN']::text[]) AS c(reason_code)
  CROSS JOIN (VALUES (NULL::text), ('Recount')) AS n(reason_note)
  CROSS JOIN (VALUES (NULL::uuid), (${PROBE_UUID})) AS o(opening_batch_id)
  CROSS JOIN (VALUES (NULL::uuid), (${PROBE_UUID})) AS g(goods_receipt_id)
  CROSS JOIN (VALUES (NULL::uuid), (${PROBE_UUID})) AS j(adjustment_id)`;

/**
 * The Build 2 Slice 6 stocktake schema (ADR-008 section 12; plan 005, W3)
 * against the migrated test database: every stocktake and line CHECK, the
 * one-DRAFT index, the COUNT_CORRECTION movement rules and their partial
 * unique index, the Slice 5 movement rules that must not have loosened, and
 * the application role's table and column privileges. Rows are written as
 * the owner so the constraints, not the adapters, are under test; privileges
 * are probed as the application role.
 */
describe("stocktake constraints and privileges (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const app = appPool();
  afterAll(() => app.end());

  let a: InventoryTenant;
  let b: InventoryTenant;
  let a1: ProductVariantId;
  let a2: ProductVariantId;
  let b1: ProductVariantId;
  let packA1: ProductPack;
  let docs: { readonly opening: string; readonly receipt: string; readonly adjustment: string };
  const versions = new Map<string, number>();

  const newId = () => harness.world().ids.newId("Row");
  const insert = (table: string, row: Row, client: pg.Pool | pg.PoolClient = harness.owner) =>
    insertRow(client, table, row);
  async function rejects(table: string, row: Row, code: string, constraint?: string | RegExp) {
    const failure = await violation(insert(table, row));
    expect(failure.code).toBe(code);
    if (typeof constraint === "string") expect(failure.constraint).toBe(constraint);
    if (constraint instanceof RegExp) expect(failure.constraint).toMatch(constraint);
  }

  const recording = (t: InventoryTenant): Row => ({
    actor_membership_id: t.membershipId,
    source_channel: "web",
    correlation_id: "test-request",
    occurred_at: AT,
    business_date: "2026-10-01",
    recorded_at: AT,
  });
  const draft = (t: InventoryTenant, extra: Row = {}): Row => ({
    business_id: t.businessId,
    id: newId(),
    location_id: t.locationId,
    status: "DRAFT",
    version: 1,
    note: null,
    created_by_membership_id: t.membershipId,
    created_at: AT,
    ...extra,
  });
  const posted = (t: InventoryTenant, extra: Row = {}): Row =>
    draft(t, {
      status: "POSTED",
      version: 2,
      posted_at: LATER,
      posted_by_membership_id: t.membershipId,
      business_date: "2026-10-01",
      ...extra,
    });
  const cancelled = (t: InventoryTenant, extra: Row = {}): Row =>
    draft(t, {
      status: "CANCELLED",
      version: 2,
      cancelled_at: LATER,
      cancelled_by_membership_id: t.membershipId,
      ...extra,
    });
  const line = (t: InventoryTenant, stocktakeId: unknown, variantId: string, extra: Row = {}): Row => ({
    business_id: t.businessId,
    stocktake_id: stocktakeId,
    variant_id: variantId,
    status: "COUNTED",
    counted_quantity_minor: "7",
    stock_unit_code: "PIECE",
    expected_at_count_minor: "5",
    balance_version_at_count: 0,
    version: 1,
    counted_by_membership_id: t.membershipId,
    counted_at: AT,
    variance_minor: null,
    ...extra,
  });
  /** A movement at the next version of its stock item. */
  function movement(t: InventoryTenant, variantId: string, extra: Row): Row {
    const key = `${t.locationId}:${variantId}`;
    const version = (versions.get(key) ?? 0) + 1;
    versions.set(key, version);
    return {
      business_id: t.businessId,
      id: newId(),
      location_id: t.locationId,
      variant_id: variantId,
      quantity_delta_minor: "2",
      balance_after_minor: "7",
      balance_version: version,
      ...recording(t),
      ...extra,
    };
  }
  /** A COUNT_CORRECTION of +2 for a stocktake line, in tenant a by default. */
  const correction = (stocktakeId: unknown, variantId: string, extra: Row = {}, t: InventoryTenant = a) =>
    movement(t, variantId, { type: "COUNT_CORRECTION", stocktake_id: stocktakeId, ...extra });
  const receiptLine = (variantId: string, extra: Row = {}) =>
    movement(a, variantId, {
      type: "PURCHASE_RECEIPT",
      quantity_delta_minor: "5",
      goods_receipt_id: docs.receipt,
      ...extra,
    });

  /** A stocktake (POSTED by default, so more can follow) with a COUNTED line per variant. */
  async function stocktakeWithLines(t: InventoryTenant, variants: readonly string[], header: Row = posted(t)) {
    await insert("stocktakes", header);
    for (const variantId of variants) await insert("stocktake_lines", line(t, header["id"], variantId));
    return header["id"] as string;
  }

  beforeEach(async () => {
    versions.clear();
    a = await inventoryTenant(harness, "stocktake-constraints-a");
    b = await inventoryTenant(harness, "stocktake-constraints-b", "KES");
    const productA1 = await inventoryProduct(harness, a, { name: "Rice" });
    const productA2 = await inventoryProduct(harness, a, { name: "Beans" });
    const productB1 = await inventoryProduct(harness, b, { name: "Rice" });
    a1 = productA1.variant.id;
    a2 = productA2.variant.id;
    b1 = productB1.variant.id;
    packA1 = await inventoryPack(harness, productA1.variant, "Carton", 24n);
    const opening = { business_id: a.businessId, id: newId(), location_id: a.locationId, ...recording(a) };
    const receipt = { ...opening, id: newId(), status: "POSTED" };
    const adjustment = { ...opening, id: newId(), kind: "ADJUSTMENT", reason_code: "FOUND_STOCK", status: "POSTED" };
    await insert("inventory_opening_batches", opening);
    await insert("goods_receipts", receipt);
    await insert("inventory_adjustments", adjustment);
    docs = { opening: opening.id, receipt: receipt.id, adjustment: adjustment.id };
  });

  describe("stocktake headers (plan section 32)", () => {
    it("accepts a DRAFT, a POSTED and a CANCELLED stocktake, and a trimmed note of 500 characters", async () => {
      await insert("stocktakes", draft(a, { note: "Shelf A" }));
      await insert("stocktakes", posted(a, { note: "x".repeat(500) }));
      await insert("stocktakes", cancelled(a));
      await insert("stocktakes", posted(a, { posted_at: AT }));
    });

    it("rejects an unknown status, version 0 and a blank, untrimmed or overlong note (23514)", async () => {
      await rejects("stocktakes", draft(a, { status: "OPEN" }), CHECK, "stocktakes_status_valid");
      await rejects("stocktakes", draft(a, { status: "draft" }), CHECK, "stocktakes_status_valid");
      await rejects("stocktakes", draft(a, { version: 0 }), CHECK, "stocktakes_version_positive");
      for (const note of ["", "   ", " Shelf A", "Shelf A ", "x".repeat(501)]) {
        await rejects("stocktakes", draft(a, { note }), CHECK, "stocktakes_note_valid");
      }
    });

    it("a DRAFT carries no posting and no cancellation field", async () => {
      for (const field of [
        { posted_at: LATER },
        { posted_by_membership_id: a.membershipId },
        { business_date: "2026-10-01" },
      ]) {
        await rejects("stocktakes", draft(a, field), CHECK, "stocktakes_posted_shape");
      }
      for (const field of [{ cancelled_at: LATER }, { cancelled_by_membership_id: a.membershipId }]) {
        await rejects("stocktakes", draft(a, field), CHECK, "stocktakes_cancelled_shape");
      }
    });

    it("a POSTED stocktake has all three posting fields and no cancellation field", async () => {
      for (const missing of ["posted_at", "posted_by_membership_id", "business_date"]) {
        await rejects("stocktakes", posted(a, { [missing]: null }), CHECK, "stocktakes_posted_shape");
      }
      await rejects("stocktakes", posted(a, { cancelled_at: LATER }), CHECK, "stocktakes_cancelled_shape");
      await rejects(
        "stocktakes",
        posted(a, { cancelled_at: LATER, cancelled_by_membership_id: a.membershipId }),
        CHECK,
        "stocktakes_cancelled_shape",
      );
    });

    it("a CANCELLED stocktake has both cancellation fields and no posting field", async () => {
      for (const missing of ["cancelled_at", "cancelled_by_membership_id"]) {
        await rejects("stocktakes", cancelled(a, { [missing]: null }), CHECK, "stocktakes_cancelled_shape");
      }
      for (const field of [
        { posted_at: LATER },
        { posted_by_membership_id: a.membershipId },
        { business_date: "2026-10-01" },
        { posted_at: LATER, posted_by_membership_id: a.membershipId, business_date: "2026-10-01" },
      ]) {
        await rejects("stocktakes", cancelled(a, field), CHECK, "stocktakes_posted_shape");
      }
    });

    it("rejects posting or cancelling before creation", async () => {
      await rejects("stocktakes", posted(a, { posted_at: EARLIER }), CHECK, "stocktakes_posted_after_created");
      await rejects("stocktakes", cancelled(a, { cancelled_at: EARLIER }), CHECK, "stocktakes_cancelled_after_created");
    });

    it("rejects another business's location and memberships (23503)", async () => {
      await rejects(
        "stocktakes",
        draft(a, { location_id: b.locationId }),
        FOREIGN_KEY,
        "stocktakes_business_id_location_id_fkey",
      );
      await rejects(
        "stocktakes",
        draft(a, { created_by_membership_id: b.membershipId }),
        FOREIGN_KEY,
        "stocktakes_business_id_created_by_membership_id_fkey",
      );
      await rejects(
        "stocktakes",
        posted(a, { posted_by_membership_id: b.membershipId }),
        FOREIGN_KEY,
        "stocktakes_business_id_posted_by_membership_id_fkey",
      );
      await rejects(
        "stocktakes",
        cancelled(a, { cancelled_by_membership_id: b.membershipId }),
        FOREIGN_KEY,
        "stocktakes_business_id_cancelled_by_membership_id_fkey",
      );
    });
  });

  describe("stocktake lines (plan section 33)", () => {
    let stocktakeA: string;
    beforeEach(async () => {
      stocktakeA = await stocktakeWithLines(a, [], draft(a));
    });

    it("accepts a COUNTED line, with and without a variance, and a REMOVED line without one", async () => {
      await insert("stocktake_lines", line(a, stocktakeA, a1));
      await insert("stocktake_lines", line(a, stocktakeA, a2, { status: "REMOVED" }));
      const postedId = await stocktakeWithLines(a, []);
      await insert("stocktake_lines", line(a, postedId, a1, { variance_minor: "2" }));
      await insert(
        "stocktake_lines",
        line(a, postedId, a2, {
          counted_quantity_minor: `${BOUND}`,
          expected_at_count_minor: `${-BOUND}`,
          variance_minor: `${-BOUND}`,
        }),
      );
    });

    it("rejects counted and expected quantities beyond their ranges", async () => {
      await rejects(
        "stocktake_lines",
        line(a, stocktakeA, a1, { counted_quantity_minor: "-1" }),
        CHECK,
        "stocktake_lines_counted_quantity_range",
      );
      await rejects(
        "stocktake_lines",
        line(a, stocktakeA, a1, { counted_quantity_minor: `${BOUND + 1n}` }),
        CHECK,
        "stocktake_lines_counted_quantity_range",
      );
      await rejects(
        "stocktake_lines",
        line(a, stocktakeA, a1, { expected_at_count_minor: `${-BOUND - 1n}` }),
        CHECK,
        "stocktake_lines_expected_at_count_range",
      );
      await rejects(
        "stocktake_lines",
        line(a, stocktakeA, a1, { expected_at_count_minor: `${BOUND + 1n}` }),
        CHECK,
        "stocktake_lines_expected_at_count_range",
      );
    });

    it("rejects a negative balance version, version 0, an out-of-range variance and a variance on a REMOVED line", async () => {
      await rejects(
        "stocktake_lines",
        line(a, stocktakeA, a1, { balance_version_at_count: -1 }),
        CHECK,
        "stocktake_lines_balance_version_non_negative",
      );
      await rejects(
        "stocktake_lines",
        line(a, stocktakeA, a1, { version: 0 }),
        CHECK,
        "stocktake_lines_version_positive",
      );
      for (const variance of [`${BOUND + 1n}`, `${-BOUND - 1n}`]) {
        await rejects(
          "stocktake_lines",
          line(a, stocktakeA, a1, { variance_minor: variance }),
          CHECK,
          "stocktake_lines_variance_range",
        );
      }
      await rejects(
        "stocktake_lines",
        line(a, stocktakeA, a1, { status: "REMOVED", variance_minor: "2" }),
        CHECK,
        "stocktake_lines_variance_counted_only",
      );
      await rejects(
        "stocktake_lines",
        line(a, stocktakeA, a1, { status: "DELETED" }),
        CHECK,
        "stocktake_lines_status_valid",
      );
    });

    it("rejects another business's stocktake, variant and membership, and an unknown unit (23503)", async () => {
      const stocktakeB = await stocktakeWithLines(b, [], draft(b));
      await rejects(
        "stocktake_lines",
        line(a, stocktakeB, a1),
        FOREIGN_KEY,
        "stocktake_lines_business_id_stocktake_id_fkey",
      );
      await rejects(
        "stocktake_lines",
        line(a, stocktakeA, b1),
        FOREIGN_KEY,
        "stocktake_lines_business_id_variant_id_fkey",
      );
      await rejects(
        "stocktake_lines",
        line(a, stocktakeA, a1, { counted_by_membership_id: b.membershipId }),
        FOREIGN_KEY,
        "stocktake_lines_business_id_counted_by_membership_id_fkey",
      );
      await rejects(
        "stocktake_lines",
        line(a, stocktakeA, a1, { stock_unit_code: "CRATE" }),
        FOREIGN_KEY,
        "stocktake_lines_stock_unit_code_fkey",
      );
    });

    it("one line per variant per stocktake (23505)", async () => {
      await insert("stocktake_lines", line(a, stocktakeA, a1));
      await rejects("stocktake_lines", line(a, stocktakeA, a1, { status: "REMOVED" }), UNIQUE, "stocktake_lines_pkey");
      const other = await stocktakeWithLines(a, []);
      await insert("stocktake_lines", line(a, other, a1));
    });
  });

  describe("one DRAFT per location (plan section 34)", () => {
    it("a second DRAFT at the same location is rejected; another location or business is independent", async () => {
      await insert("stocktakes", draft(a));
      await rejects("stocktakes", draft(a), UNIQUE, "stocktakes_one_draft");
      const back: LocationId = await secondLocation(harness, a.businessId);
      await insert("stocktakes", draft(a, { location_id: back }));
      await insert("stocktakes", draft(b));
    });

    it("after the DRAFT is POSTED, or CANCELLED, a new DRAFT is allowed", async () => {
      for (const [status, columns] of [
        ["POSTED", `posted_at = $2, posted_by_membership_id = $3, business_date = '2026-10-01'`],
        ["CANCELLED", `cancelled_at = $2, cancelled_by_membership_id = $3`],
      ] as const) {
        const first = draft(a);
        await insert("stocktakes", first);
        await rejects("stocktakes", draft(a), UNIQUE, "stocktakes_one_draft");
        await harness.owner.query(`UPDATE stocktakes SET status = $4, version = 2, ${columns} WHERE id = $1`, [
          first["id"],
          LATER,
          a.membershipId,
          status,
        ]);
        await insert("stocktakes", posted(a));
      }
      await insert("stocktakes", draft(a));
    });
  });

  describe("COUNT_CORRECTION movements (plan sections 35 and 18)", () => {
    let stocktake: string;
    beforeEach(async () => {
      stocktake = await stocktakeWithLines(a, [a1, a2]);
    });

    it("accepts a COUNT_CORRECTION in either direction, up to the existing 10^15 bounds", async () => {
      await insert("inventory_movements", correction(stocktake, a1));
      await insert(
        "inventory_movements",
        correction(stocktake, a2, { quantity_delta_minor: "-3", balance_after_minor: "2" }),
      );
      const extreme = await stocktakeWithLines(a, [a1]);
      await insert(
        "inventory_movements",
        correction(extreme, a1, { quantity_delta_minor: `${BOUND}`, balance_after_minor: `${BOUND}` }),
      );
    });

    it("an out-of-range correction is never stored: current -10^15 counted +10^15 is rejected (23514)", async () => {
      await rejects(
        "inventory_movements",
        correction(stocktake, a1, { quantity_delta_minor: `${2n * BOUND}`, balance_after_minor: `${BOUND}` }),
        CHECK,
        "inventory_movements_delta_nonzero",
      );
      await rejects(
        "inventory_movements",
        correction(stocktake, a1, { quantity_delta_minor: `${-BOUND - 1n}`, balance_after_minor: "0" }),
        CHECK,
        "inventory_movements_delta_nonzero",
      );
      await rejects(
        "inventory_movements",
        correction(stocktake, a1, { quantity_delta_minor: "0", balance_after_minor: "5" }),
        CHECK,
        "inventory_movements_delta_nonzero",
      );
      await rejects(
        "inventory_movements",
        correction(stocktake, a1, { quantity_delta_minor: "1", balance_after_minor: `${BOUND + 1n}` }),
        CHECK,
        "inventory_movements_balance_after_range",
      );
    });

    it("a COUNT_CORRECTION's only source is its stocktake line", async () => {
      await rejects("inventory_movements", correction(null, a1), CHECK);
      for (const source of [
        { opening_batch_id: docs.opening },
        { goods_receipt_id: docs.receipt },
        { adjustment_id: docs.adjustment },
      ]) {
        await rejects("inventory_movements", correction(null, a1, source), CHECK);
        await rejects("inventory_movements", correction(stocktake, a1, source), CHECK);
      }
    });

    it("no other type may carry a stocktake_id", async () => {
      await rejects("inventory_movements", receiptLine(a1, { stocktake_id: stocktake }), CHECK);
      await rejects("inventory_movements", receiptLine(a1, { goods_receipt_id: null, stocktake_id: stocktake }), CHECK);
      for (const type of ["OPENING", "ADJUSTMENT", "WRITE_OFF"]) {
        await rejects(
          "inventory_movements",
          correction(stocktake, a1, { type, reason_code: type === "OPENING" ? null : "OTHER", reason_note: null }),
          CHECK,
        );
      }
    });

    it("the stocktake line must exist in the same business for the same variant (23503)", async () => {
      const lineKey = "inventory_movements_business_id_stocktake_id_variant_id_fkey";
      // Another business's or an unknown stocktake breaks both stocktake references; either may be reported.
      const eitherKey = /^inventory_movements_business_id_stocktake_id_(variant|location)_id_fkey$/;
      const foreign = await stocktakeWithLines(b, [b1]);
      await rejects("inventory_movements", correction(foreign, a1), FOREIGN_KEY, eitherKey);
      await rejects("inventory_movements", correction(foreign, b1), FOREIGN_KEY);
      const onlyA1 = await stocktakeWithLines(a, [a1]);
      await rejects("inventory_movements", correction(onlyA1, a2), FOREIGN_KEY, lineKey);
      await rejects("inventory_movements", correction(newId(), a1), FOREIGN_KEY, eitherKey);
    });

    it("a COUNT_CORRECTION is recorded at its stocktake's location (23503)", async () => {
      const back = await secondLocation(harness, a.businessId);
      await rejects(
        "inventory_movements",
        correction(stocktake, a1, { location_id: back }),
        FOREIGN_KEY,
        "inventory_movements_business_id_stocktake_id_location_id_fkey",
      );
      const atBack = await stocktakeWithLines(a, [a1], posted(a, { location_id: back }));
      await rejects(
        "inventory_movements",
        correction(atBack, a1),
        FOREIGN_KEY,
        "inventory_movements_business_id_stocktake_id_location_id_fkey",
      );
      await insert("inventory_movements", correction(atBack, a1, { location_id: back }));
      await insert("inventory_movements", correction(stocktake, a1));
    });

    it("a COUNT_CORRECTION is never a reversal and never reversed", async () => {
      const original = correction(stocktake, a1);
      await insert("inventory_movements", original);
      const other = await stocktakeWithLines(a, [a1]);
      await rejects(
        "inventory_movements",
        correction(other, a1, {
          quantity_delta_minor: "-2",
          balance_after_minor: "5",
          reverses_movement_id: original["id"],
          reason_note: "Counted the wrong shelf",
        }),
        CHECK,
      );
    });

    it("a COUNT_CORRECTION carries no pack snapshot, reason code or reason note", async () => {
      await rejects(
        "inventory_movements",
        correction(stocktake, a1, {
          quantity_delta_minor: "24",
          balance_after_minor: "29",
          pack_id: packA1.id,
          pack_name: "Carton",
          pack_count: "1",
          pack_factor_minor: "24",
        }),
        CHECK,
        "inventory_movements_count_correction_no_pack",
      );
      for (const reason of [
        { reason_code: "FOUND_STOCK" },
        { reason_code: "OTHER", reason_note: "Recount" },
        { reason_note: "Recount" },
      ]) {
        await rejects(
          "inventory_movements",
          correction(stocktake, a1, reason),
          CHECK,
          "inventory_movements_reason_shape",
        );
      }
    });
  });

  describe("one COUNT_CORRECTION per stocktake line (plan section 36)", () => {
    it("a second correction for the same line violates the partial unique index, not the version key", async () => {
      const stocktake = await stocktakeWithLines(a, [a1, a2]);
      await insert("inventory_movements", correction(stocktake, a1));
      await rejects(
        "inventory_movements",
        correction(stocktake, a1, { quantity_delta_minor: "1", balance_after_minor: "8" }),
        UNIQUE,
        "inventory_movements_count_correction_unique",
      );
      await insert("inventory_movements", correction(stocktake, a2));
      const next = await stocktakeWithLines(a, [a1]);
      await insert(
        "inventory_movements",
        correction(next, a1, { quantity_delta_minor: "-1", balance_after_minor: "6" }),
      );
    });
  });

  describe("Slice 5 movements are unchanged (plan section 37)", () => {
    it("OPENING, PURCHASE_RECEIPT, ADJUSTMENT and WRITE_OFF originals and their reversals are still accepted", async () => {
      const writeOff = { ...recording(a), business_id: a.businessId, id: newId(), location_id: a.locationId };
      await insert("inventory_adjustments", {
        ...writeOff,
        kind: "WRITE_OFF",
        reason_code: "DAMAGED",
        status: "POSTED",
      });
      const opening = movement(a, a1, { type: "OPENING", quantity_delta_minor: "10", opening_batch_id: docs.opening });
      const receipt = receiptLine(a1);
      const adjustment = movement(a, a1, {
        type: "ADJUSTMENT",
        quantity_delta_minor: "-2",
        adjustment_id: docs.adjustment,
        reason_code: "FOUND_STOCK",
      });
      const loss = movement(a, a1, {
        type: "WRITE_OFF",
        quantity_delta_minor: "-1",
        adjustment_id: writeOff.id,
        reason_code: "OTHER",
        reason_note: "Rats",
      });
      for (const row of [opening, receipt, adjustment, loss]) await insert("inventory_movements", row);
      for (const original of [receipt, adjustment, loss]) {
        await insert(
          "inventory_movements",
          movement(a, a1, {
            type: original["type"],
            quantity_delta_minor: `${-BigInt(original["quantity_delta_minor"] as string)}`,
            goods_receipt_id: original["goods_receipt_id"] ?? null,
            adjustment_id: original["adjustment_id"] ?? null,
            reverses_movement_id: original["id"],
            reason_note: "Entered in error",
          }),
        );
      }
    });

    it("a previously invalid Slice 5 movement stays invalid, with or without a stocktake reference", async () => {
      const stocktake = await stocktakeWithLines(a, [a1]);
      for (const row of [
        receiptLine(a1, { type: "SALE" }),
        receiptLine(a1, { quantity_delta_minor: "-5" }),
        receiptLine(a1, { goods_receipt_id: null }),
        receiptLine(a1, { reason_code: "FOUND_STOCK" }),
        movement(a, a1, { type: "OPENING", quantity_delta_minor: "-1", opening_batch_id: docs.opening }),
        movement(a, a1, { type: "ADJUSTMENT", adjustment_id: docs.adjustment, reason_code: "DAMAGED" }),
        movement(a, a1, { type: "ADJUSTMENT", adjustment_id: docs.adjustment, reason_code: "OTHER" }),
        movement(a, a1, { type: "OPENING", opening_batch_id: docs.opening, stocktake_id: stocktake }),
        movement(a, a1, {
          type: "ADJUSTMENT",
          adjustment_id: docs.adjustment,
          reason_code: "FOUND_STOCK",
          stocktake_id: stocktake,
        }),
      ]) {
        const { type, quantity_delta_minor, reason_code, stocktake_id } = row;
        const label = JSON.stringify({
          type,
          quantity_delta_minor,
          reason_code,
          stocktake: stocktake_id !== undefined,
        });
        const outcome = await insert("inventory_movements", row).then(
          () => "accepted",
          (error: unknown) => String((error as { code?: unknown }).code),
        );
        expect(outcome, label).toBe(CHECK);
      }
    });

    it("for every non-COUNT_CORRECTION row, the replaced CHECKs keep every valid Slice 5 row valid and every invalid one invalid", async () => {
      const replaced = await harness.owner.query<{ name: string; definition: string }>(
        `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'inventory_movements'::regclass AND conname = ANY($1::text[])`,
        [Object.keys(SLICE_5_REPLACED_CHECKS)],
      );
      expect(replaced.rows).toHaveLength(4);
      for (const { name, definition } of replaced.rows) {
        const before = `((${SLICE_5_REPLACED_CHECKS[name as keyof typeof SLICE_5_REPLACED_CHECKS]}) IS NOT FALSE)`;
        const after = `((${definition.replace(/^CHECK /, "")}) IS NOT FALSE)`;
        const { rows } = await harness.owner.query<{
          total: number;
          accepted: number;
          loosened: number;
          tightened: number;
          nullReasonFixed: number;
        }>(
          `WITH grid AS (${CHECK_GRID})
           SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE ${before})::int AS accepted,
                  count(*) FILTER (WHERE NOT ${before} AND ${after})::int AS loosened,
                  count(*) FILTER (WHERE ${before} AND NOT ${after} AND NOT (${NULL_REASON_BUG}))::int AS tightened,
                  count(*) FILTER (WHERE ${before} AND NOT ${after} AND (${NULL_REASON_BUG}))::int AS "nullReasonFixed"
           FROM grid`,
        );
        // Only the reason shape changes, and only by rejecting the 64 grid rows of the NULL reason-code bug.
        const fixed = name === "inventory_movements_reason_shape" ? 64 : 0;
        expect(rows[0], name).toEqual({
          total: 2880,
          accepted: expect.any(Number) as number,
          loosened: 0,
          tightened: 0,
          nullReasonFixed: fixed,
        });
        expect(rows[0]?.accepted, name).toBeGreaterThan(0);
      }
    });

    it("an original ADJUSTMENT or WRITE_OFF without a reason code is rejected (the Slice 5 NULL gap is closed)", async () => {
      const writeOff = { ...recording(a), business_id: a.businessId, id: newId(), location_id: a.locationId };
      await insert("inventory_adjustments", {
        ...writeOff,
        kind: "WRITE_OFF",
        reason_code: "DAMAGED",
        status: "POSTED",
      });
      for (const note of [null, "Recount"]) {
        await rejects(
          "inventory_movements",
          movement(a, a1, { type: "ADJUSTMENT", adjustment_id: docs.adjustment, reason_code: null, reason_note: note }),
          CHECK,
          "inventory_movements_reason_shape",
        );
        await rejects(
          "inventory_movements",
          movement(a, a1, {
            type: "WRITE_OFF",
            quantity_delta_minor: "-1",
            adjustment_id: writeOff.id,
            reason_code: null,
            reason_note: note,
          }),
          CHECK,
          "inventory_movements_reason_shape",
        );
      }
      await insert(
        "inventory_movements",
        movement(a, a1, { type: "ADJUSTMENT", adjustment_id: docs.adjustment, reason_code: "FOUND_STOCK" }),
      );
      await insert(
        "inventory_movements",
        movement(a, a1, {
          type: "WRITE_OFF",
          quantity_delta_minor: "-1",
          adjustment_id: writeOff.id,
          reason_code: "DAMAGED",
        }),
      );
    });
  });

  describe("audit entity type (plan section 22 finding)", () => {
    const auditRow = (entityType: string): Row => ({
      business_id: a.businessId,
      id: newId(),
      occurred_at: AT,
      action: "inventory.stocktake_created",
      entity_type: entityType,
      entity_id: newId(),
      actor_type: "system",
      actor_name: "test",
      source_channel: "system",
      correlation_id: "test-request",
      payload: "{}",
      payload_schema_version: 1,
    });

    it("the stocktake entity type is accepted; a malformed entity type is rejected by the format CHECK", async () => {
      await insert("business_audit_records", auditRow("stocktake"));
      for (const entityType of ["Stocktake", "stock-take", "stocktake.line", "", "x".repeat(65)]) {
        await rejects(
          "business_audit_records",
          auditRow(entityType),
          CHECK,
          "business_audit_records_entity_type_format",
        );
      }
    });
  });

  describe("application-role privileges (plan section 38)", () => {
    it("stocktakes: SELECT and INSERT; UPDATE on the lifecycle columns only; no DELETE or TRUNCATE", async () => {
      const header = draft(a);
      await insert("stocktakes", header, app);
      const { rowCount } = await app.query(`SELECT id FROM stocktakes WHERE id = $1`, [header["id"]]);
      expect(rowCount).toBe(1);
      for (const column of STOCKTAKE_LIFECYCLE_COLUMNS) {
        await app.query(`UPDATE stocktakes SET "${column}" = "${column}" WHERE id = $1`, [header["id"]]);
      }
      for (const column of STOCKTAKE_IMMUTABLE_COLUMNS) {
        expect(await sqlState(app.query(`UPDATE stocktakes SET "${column}" = "${column}" WHERE false`))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
      expect(await sqlState(app.query(`DELETE FROM stocktakes WHERE false`))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.query(`TRUNCATE stocktakes`))).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("stocktake lines: SELECT and INSERT; UPDATE on the count and variance columns only; no DELETE or TRUNCATE", async () => {
      const stocktake = await stocktakeWithLines(a, [], draft(a));
      await insert("stocktake_lines", line(a, stocktake, a1), app);
      const { rowCount } = await app.query(`SELECT variant_id FROM stocktake_lines WHERE stocktake_id = $1`, [
        stocktake,
      ]);
      expect(rowCount).toBe(1);
      for (const column of LINE_COUNT_COLUMNS) {
        await app.query(`UPDATE stocktake_lines SET "${column}" = "${column}" WHERE stocktake_id = $1`, [stocktake]);
      }
      for (const column of LINE_IDENTITY_COLUMNS) {
        expect(await sqlState(app.query(`UPDATE stocktake_lines SET "${column}" = "${column}" WHERE false`))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
      expect(await sqlState(app.query(`DELETE FROM stocktake_lines WHERE false`))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.query(`TRUNCATE stocktake_lines`))).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("the column grants back SELECT ... FOR UPDATE row locks on both tables", async () => {
      const stocktake = await stocktakeWithLines(a, [a1], draft(a));
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        const header = await client.query(`SELECT id FROM stocktakes WHERE id = $1 FOR UPDATE`, [stocktake]);
        const lines = await client.query(`SELECT variant_id FROM stocktake_lines WHERE stocktake_id = $1 FOR UPDATE`, [
          stocktake,
        ]);
        expect([header.rowCount, lines.rowCount]).toEqual([1, 1]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("movements stay insert-only: UPDATE, including of stocktake_id, DELETE and TRUNCATE are denied", async () => {
      const stocktake = await stocktakeWithLines(a, [a1]);
      await insert("inventory_movements", correction(stocktake, a1), app);
      for (const column of ["stocktake_id", "type", "quantity_delta_minor"]) {
        expect(await sqlState(app.query(`UPDATE inventory_movements SET "${column}" = "${column}" WHERE false`))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
      expect(await sqlState(app.query(`DELETE FROM inventory_movements WHERE false`))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.query(`TRUNCATE inventory_movements`))).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("PUBLIC holds no table or column privilege on the stocktake tables", async () => {
      const tables = await harness.owner.query(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'PUBLIC' AND table_name IN ('stocktakes', 'stocktake_lines', 'inventory_movements')`,
      );
      expect(tables.rows).toEqual([]);
      const columns = await harness.owner.query(
        `SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
         WHERE a.attacl IS NOT NULL AND acl.grantee = 0 AND c.relname IN ('stocktakes', 'stocktake_lines', 'inventory_movements')`,
      );
      expect(columns.rows).toEqual([]);
    });
  });

  describe("test fixture reset (plan section 25)", () => {
    it("TENANCY_TABLES resets every non-reference table, stocktake lines before stocktakes", async () => {
      const { rows } = await harness.owner.query<{ name: string }>(
        `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'
         AND tablename NOT IN ('_prisma_migrations', 'currencies', 'units_of_measure')`,
      );
      expect([...TENANCY_TABLES].sort()).toEqual(rows.map((row) => row.name).sort());
      const order = TENANCY_TABLES as readonly string[];
      expect(order.indexOf("inventory_movements")).toBeLessThan(order.indexOf("stocktake_lines"));
      expect(order.indexOf("stocktake_lines")).toBeLessThan(order.indexOf("stocktakes"));
    });
  });
});
