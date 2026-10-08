import type { ProductPack, ProductVariantId } from "@tali/domain";
import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
const BOUND = 1_000_000_000_000_000n;
const INVENTORY_TABLES = [
  "inventory_opening_batches",
  "goods_receipts",
  "inventory_adjustments",
  "inventory_movements",
  "inventory_balances",
  "inventory_stock_thresholds",
] as const;
const REVERSAL_COLUMNS = ["status", "reversed_at", "reversed_by_membership_id", "reversal_reason"] as const;

type Row = Record<string, unknown>;

/**
 * The Build 2 Slice 5 inventory schema (ADR-008 sections 7, 8, 9 and 11)
 * against the migrated test database: every CHECK, composite foreign key and
 * unique index, the movement reason rules (plan section 33), exact pack
 * arithmetic in NUMERIC (section 34) and the application role's table and
 * column privileges (section 35). Rows are written as the owner so the
 * constraints, not the adapters, are under test; privileges are probed as
 * the application role.
 */
describe("inventory constraints and privileges (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const app = appPool();
  afterAll(() => app.end());

  let a: InventoryTenant;
  let b: InventoryTenant;
  let a1: ProductVariantId;
  let a2: ProductVariantId;
  let b1: ProductVariantId;
  let packA1: ProductPack;
  let packA2: ProductPack;
  let docs: {
    readonly opening: string;
    readonly receipt: string;
    readonly adjustment: string;
    readonly writeOff: string;
    readonly openingB: string;
    readonly receiptB: string;
  };
  const versions = new Map<string, number>();

  const newId = () => harness.world().ids.newId("Row");
  const insert = (table: string, row: Row, client: pg.Pool | pg.PoolClient = harness.owner) =>
    insertRow(client, table, row);
  const recording = (t: InventoryTenant): Row => ({
    actor_membership_id: t.membershipId,
    source_channel: "web",
    correlation_id: "test-request",
    occurred_at: AT,
    business_date: "2026-10-01",
    recorded_at: AT,
  });
  const header = (t: InventoryTenant, extra: Row = {}): Row => ({
    business_id: t.businessId,
    id: newId(),
    location_id: t.locationId,
    ...recording(t),
    ...extra,
  });
  const receiptRow = (t: InventoryTenant, extra: Row = {}) => header(t, { status: "POSTED", ...extra });
  const adjustmentRow = (t: InventoryTenant, kind: string, reasonCode: string, extra: Row = {}) =>
    header(t, { kind, reason_code: reasonCode, status: "POSTED", ...extra });

  /** A PURCHASE_RECEIPT original of +5 on the receipt by default, at the next version of its stock item. */
  function movement(variantId: string, extra: Row = {}, t: InventoryTenant = a): Row {
    const locationId = (extra["location_id"] as string | undefined) ?? t.locationId;
    const key = `${locationId}:${variantId}`;
    const version = (versions.get(key) ?? 0) + 1;
    versions.set(key, version);
    return {
      business_id: t.businessId,
      id: newId(),
      location_id: locationId,
      variant_id: variantId,
      type: "PURCHASE_RECEIPT",
      quantity_delta_minor: "5",
      balance_after_minor: "5",
      balance_version: version,
      goods_receipt_id: docs.receipt,
      ...recording(t),
      ...extra,
    };
  }
  const receiptOriginal = (variantId: string, extra: Row = {}) => movement(variantId, extra);
  const reversalOf = (original: Row, extra: Row = {}) =>
    movement(original["variant_id"] as string, {
      location_id: original["location_id"],
      type: original["type"],
      quantity_delta_minor: `${-BigInt(original["quantity_delta_minor"] as string)}`,
      balance_after_minor: "0",
      goods_receipt_id: original["goods_receipt_id"] ?? null,
      opening_batch_id: original["opening_batch_id"] ?? null,
      adjustment_id: original["adjustment_id"] ?? null,
      reverses_movement_id: original["id"],
      reason_note: "Wrong delivery",
      ...extra,
    });
  const adjustmentLine = (variantId: string, delta: string, reasonCode: string, extra: Row = {}) =>
    movement(variantId, {
      type: "ADJUSTMENT",
      quantity_delta_minor: delta,
      balance_after_minor: delta,
      goods_receipt_id: null,
      adjustment_id: docs.adjustment,
      reason_code: reasonCode,
      ...extra,
    });
  const writeOffLine = (variantId: string, delta: string, reasonCode: string, extra: Row = {}) =>
    movement(variantId, {
      type: "WRITE_OFF",
      quantity_delta_minor: delta,
      balance_after_minor: delta,
      goods_receipt_id: null,
      adjustment_id: docs.writeOff,
      reason_code: reasonCode,
      ...extra,
    });
  const openingLine = (variantId: string, extra: Row = {}) =>
    movement(variantId, {
      type: "OPENING",
      quantity_delta_minor: "10",
      balance_after_minor: "10",
      goods_receipt_id: null,
      opening_batch_id: docs.opening,
      ...extra,
    });

  async function rejects(table: string, row: Row, code: string, constraint?: string) {
    const failure = await violation(insert(table, row));
    expect(failure.code).toBe(code);
    if (constraint !== undefined) expect(failure.constraint).toBe(constraint);
  }

  beforeEach(async () => {
    versions.clear();
    a = await inventoryTenant(harness, "inventory-constraints-a");
    b = await inventoryTenant(harness, "inventory-constraints-b", "KES");
    const productA1 = await inventoryProduct(harness, a, { name: "Rice" });
    const productA2 = await inventoryProduct(harness, a, { name: "Beans" });
    const productB1 = await inventoryProduct(harness, b, { name: "Rice" });
    a1 = productA1.variant.id;
    a2 = productA2.variant.id;
    b1 = productB1.variant.id;
    packA1 = await inventoryPack(harness, productA1.variant, "Carton", 24n);
    packA2 = await inventoryPack(harness, productA2.variant, "Bag", 12n);
    const opening = header(a);
    const receipt = receiptRow(a);
    const adjustment = adjustmentRow(a, "ADJUSTMENT", "FOUND_STOCK");
    const writeOff = adjustmentRow(a, "WRITE_OFF", "DAMAGED");
    const openingB = header(b);
    const receiptB = receiptRow(b);
    await insert("inventory_opening_batches", opening);
    await insert("goods_receipts", receipt);
    await insert("inventory_adjustments", adjustment);
    await insert("inventory_adjustments", writeOff);
    await insert("inventory_opening_batches", openingB);
    await insert("goods_receipts", receiptB);
    docs = {
      opening: opening["id"] as string,
      receipt: receipt["id"] as string,
      adjustment: adjustment["id"] as string,
      writeOff: writeOff["id"] as string,
      openingB: openingB["id"] as string,
      receiptB: receiptB["id"] as string,
    };
  });

  describe("movements", () => {
    it("accepts one original of each type, a reversal, and exact pack snapshots in both directions", async () => {
      await insert("inventory_movements", openingLine(a1));
      const original = receiptOriginal(a1);
      await insert("inventory_movements", original);
      await insert("inventory_movements", reversalOf(original));
      await insert("inventory_movements", adjustmentLine(a1, "-2", "FOUND_STOCK"));
      await insert("inventory_movements", adjustmentLine(a2, "3", "DATA_ENTRY_CORRECTION"));
      await insert("inventory_movements", writeOffLine(a1, "-1", "EXPIRED"));
      const packed = { pack_id: packA2.id, pack_name: "Bag", pack_factor_minor: "12" };
      await insert(
        "inventory_movements",
        receiptOriginal(a2, { quantity_delta_minor: "48", ...packed, pack_count: "4" }),
      );
      await insert("inventory_movements", writeOffLine(a2, "-12", "SPOILED", { ...packed, pack_count: "1" }));
    });

    it("rejects an unknown type and every type/source mismatch (23514)", async () => {
      for (const row of [
        receiptOriginal(a1, { type: "SALE" }),
        receiptOriginal(a1, { type: "COUNT_CORRECTION" }),
        receiptOriginal(a1, { goods_receipt_id: null, opening_batch_id: docs.opening }),
        receiptOriginal(a1, { opening_batch_id: docs.opening }),
        receiptOriginal(a1, { goods_receipt_id: null }),
        openingLine(a1, { opening_batch_id: null, goods_receipt_id: docs.receipt }),
        adjustmentLine(a1, "2", "FOUND_STOCK", { adjustment_id: null, goods_receipt_id: docs.receipt }),
      ]) {
        expect((await violation(insert("inventory_movements", row))).code).toBe(CHECK);
      }
      await rejects("inventory_movements", receiptOriginal(a1, { type: "SALE" }), CHECK);
      expect(
        (await violation(insert("inventory_movements", receiptOriginal(a1, { opening_batch_id: docs.opening }))))
          .constraint,
      ).toMatch(/^inventory_movements_(one_source|opening_source)$/);
    });

    it("rejects a cross-tenant document, variant, location, actor, a cross-kind adjustment and a cross-variant pack (23503)", async () => {
      for (const row of [
        receiptOriginal(a1, { goods_receipt_id: docs.receiptB }),
        openingLine(a1, { opening_batch_id: docs.openingB }),
        receiptOriginal(b1),
        receiptOriginal(a1, { location_id: b.locationId }),
        receiptOriginal(a1, { actor_membership_id: b.membershipId }),
        adjustmentLine(a1, "2", "FOUND_STOCK", { adjustment_id: docs.writeOff }),
        writeOffLine(a1, "-2", "DAMAGED", { adjustment_id: docs.adjustment }),
        receiptOriginal(a1, {
          quantity_delta_minor: "12",
          pack_id: packA2.id,
          pack_name: "Bag",
          pack_count: "1",
          pack_factor_minor: "12",
        }),
      ]) {
        expect((await violation(insert("inventory_movements", row))).code).toBe(FOREIGN_KEY);
      }
    });

    it("a reversal pins the original's location, variant and type, reverses at most once, and never itself", async () => {
      const original = receiptOriginal(a1);
      await insert("inventory_movements", original);
      const elsewhere = await secondLocation(harness, a.businessId);
      await rejects("inventory_movements", reversalOf(original, { location_id: elsewhere }), FOREIGN_KEY);
      await rejects("inventory_movements", reversalOf(original, { variant_id: a2 }), FOREIGN_KEY);
      await rejects(
        "inventory_movements",
        reversalOf(original, {
          type: "ADJUSTMENT",
          goods_receipt_id: null,
          adjustment_id: docs.adjustment,
        }),
        FOREIGN_KEY,
      );
      await insert("inventory_movements", reversalOf(original));
      await rejects(
        "inventory_movements",
        reversalOf(original),
        UNIQUE,
        "inventory_movements_business_id_reverses_movement_id_key",
      );
      const self = receiptOriginal(a2, { quantity_delta_minor: "-5", reason_note: "Self" });
      await rejects(
        "inventory_movements",
        { ...self, reverses_movement_id: self["id"] },
        CHECK,
        "inventory_movements_not_self_reversal",
      );
      const packed = { pack_id: packA2.id, pack_name: "Bag", pack_count: "1", pack_factor_minor: "12" };
      const packedOriginal = receiptOriginal(a2, { quantity_delta_minor: "12", ...packed });
      await insert("inventory_movements", packedOriginal);
      await rejects(
        "inventory_movements",
        reversalOf(packedOriginal, packed),
        CHECK,
        "inventory_movements_pack_reversal",
      );
    });

    it("one OPENING per stock item ever, one original line per document and variant, one movement per version", async () => {
      await insert("inventory_movements", openingLine(a1));
      const secondBatch = header(a);
      await insert("inventory_opening_batches", secondBatch);
      await rejects(
        "inventory_movements",
        openingLine(a1, { opening_batch_id: secondBatch["id"] }),
        UNIQUE,
        "inventory_movements_one_opening",
      );
      const elsewhere = await secondLocation(harness, a.businessId);
      await rejects(
        "inventory_movements",
        openingLine(a1, { location_id: elsewhere }),
        UNIQUE,
        "inventory_movements_opening_line_unique",
      );
      await insert("inventory_movements", receiptOriginal(a1));
      await rejects("inventory_movements", receiptOriginal(a1), UNIQUE, "inventory_movements_receipt_line_unique");
      await insert("inventory_movements", adjustmentLine(a1, "1", "FOUND_STOCK"));
      await rejects(
        "inventory_movements",
        adjustmentLine(a1, "-1", "FOUND_STOCK"),
        UNIQUE,
        "inventory_movements_adjustment_line_unique",
      );
      await rejects(
        "inventory_movements",
        writeOffLine(a1, "-1", "DAMAGED", { balance_version: 1 }),
        UNIQUE,
        "inventory_movements_stock_item_version_key",
      );
    });

    it("rejects zero and out-of-range quantities, a version below 1, and each wrong direction (23514)", async () => {
      await rejects(
        "inventory_movements",
        adjustmentLine(a1, "0", "FOUND_STOCK"),
        CHECK,
        "inventory_movements_delta_nonzero",
      );
      await rejects(
        "inventory_movements",
        adjustmentLine(a1, `${BOUND + 1n}`, "FOUND_STOCK", { balance_after_minor: "0" }),
        CHECK,
        "inventory_movements_delta_nonzero",
      );
      await insert("inventory_movements", adjustmentLine(a1, `${BOUND}`, "FOUND_STOCK"));
      await rejects(
        "inventory_movements",
        adjustmentLine(a2, "1", "FOUND_STOCK", { balance_after_minor: `${-BOUND - 1n}` }),
        CHECK,
        "inventory_movements_balance_after_range",
      );
      await rejects(
        "inventory_movements",
        adjustmentLine(a2, "1", "FOUND_STOCK", { balance_version: 0 }),
        CHECK,
        "inventory_movements_balance_version_positive",
      );
      for (const row of [
        openingLine(a2, { quantity_delta_minor: "-10" }),
        receiptOriginal(a2, { quantity_delta_minor: "-5" }),
        writeOffLine(a2, "4", "DAMAGED"),
        receiptOriginal(a2, { quantity_delta_minor: "5", reverses_movement_id: newId(), reason_note: "Undo" }),
        writeOffLine(a2, "-4", "DAMAGED", { reason_code: null, reverses_movement_id: newId(), reason_note: "Undo" }),
        openingLine(a2, { quantity_delta_minor: "-10", reverses_movement_id: newId(), reason_note: "Undo" }),
      ]) {
        expect(await violation(insert("inventory_movements", row))).toEqual({
          code: CHECK,
          constraint: "inventory_movements_direction",
        });
      }
    });

    it("rejects an incomplete pack snapshot and invalid recording fields (23514)", async () => {
      await rejects(
        "inventory_movements",
        receiptOriginal(a1, { quantity_delta_minor: "24", pack_id: packA1.id }),
        CHECK,
        "inventory_movements_pack_shape",
      );
      await rejects(
        "inventory_movements",
        receiptOriginal(a1, { source_channel: "fax" }),
        CHECK,
        "inventory_movements_source_channel_valid",
      );
      await rejects(
        "inventory_movements",
        receiptOriginal(a1, { correlation_id: "bad id!" }),
        CHECK,
        "inventory_movements_correlation_id_format",
      );
      await rejects(
        "inventory_movements",
        receiptOriginal(a1, { recorded_at: "2026-10-01T07:59:59.999Z" }),
        CHECK,
        "inventory_movements_recorded_after_occurred",
      );
    });
  });

  describe("movement reasons (plan section 33)", () => {
    const shape = "inventory_movements_reason_shape";
    const note = "inventory_movements_reason_note_valid";

    it("OTHER needs a note on an original ADJUSTMENT and an original WRITE_OFF", async () => {
      await rejects("inventory_movements", adjustmentLine(a1, "1", "OTHER"), CHECK, shape);
      await rejects("inventory_movements", writeOffLine(a1, "-1", "OTHER"), CHECK, shape);
    });

    it("a reason note must be 1 to 500 trimmed characters", async () => {
      for (const reasonNote of ["", "   ", " Leak", "Leak ", "x".repeat(501)]) {
        await rejects(
          "inventory_movements",
          adjustmentLine(a1, "1", "OTHER", { reason_note: reasonNote }),
          CHECK,
          note,
        );
      }
      await insert("inventory_movements", adjustmentLine(a1, "1", "OTHER", { reason_note: "x" }));
      await insert("inventory_movements", writeOffLine(a2, "-1", "OTHER", { reason_note: "y".repeat(500) }));
    });

    it("a non-OTHER code needs no note, and may carry the document's note", async () => {
      await insert("inventory_movements", adjustmentLine(a1, "1", "FOUND_STOCK"));
      await insert("inventory_movements", writeOffLine(a1, "-1", "THEFT_OR_LOSS", { reason_note: "Shelf 3" }));
    });

    it("a reversal has no code and carries its reason as the note", async () => {
      const original = writeOffLine(a1, "-3", "DAMAGED");
      await insert("inventory_movements", original);
      await rejects("inventory_movements", reversalOf(original, { reason_code: "DAMAGED" }), CHECK, shape);
      await rejects("inventory_movements", reversalOf(original, { reason_note: null }), CHECK, shape);
      await insert("inventory_movements", reversalOf(original, { reason_code: null }));
    });

    it("OPENING and PURCHASE_RECEIPT originals carry no reason; a code from the other kind's list is rejected", async () => {
      await rejects("inventory_movements", openingLine(a1, { reason_code: "FOUND_STOCK" }), CHECK, shape);
      await rejects("inventory_movements", openingLine(a2, { reason_note: "Count" }), CHECK, shape);
      await rejects(
        "inventory_movements",
        receiptOriginal(a1, { reason_code: "OTHER", reason_note: "x" }),
        CHECK,
        shape,
      );
      await rejects("inventory_movements", receiptOriginal(a1, { reason_note: "Late truck" }), CHECK, shape);
      await rejects("inventory_movements", adjustmentLine(a1, "-1", "DAMAGED"), CHECK, shape);
      await rejects("inventory_movements", writeOffLine(a1, "-1", "FOUND_STOCK"), CHECK, shape);
    });
  });

  describe("pack arithmetic (plan section 34)", () => {
    const pack = (count: string, factor: string, extra: Row = {}) => ({
      pack_id: packA1.id,
      pack_name: "Carton",
      pack_count: count,
      pack_factor_minor: factor,
      ...extra,
    });
    const arithmetic = "inventory_movements_pack_arithmetic";

    it("accepts an exact count times factor for a positive and a negative delta", async () => {
      await insert("inventory_movements", receiptOriginal(a1, { quantity_delta_minor: "48", ...pack("2", "24") }));
      await insert("inventory_movements", writeOffLine(a1, "-24", "DAMAGED", pack("1", "24")));
    });

    it("rejects an off-by-one product, a count of 0 or above 10^15, and a factor of 1 or above 10^9 (23514)", async () => {
      for (const row of [
        receiptOriginal(a1, { quantity_delta_minor: "49", ...pack("2", "24") }),
        receiptOriginal(a1, { quantity_delta_minor: "47", ...pack("2", "24") }),
        writeOffLine(a1, "-25", "DAMAGED", pack("1", "24")),
        receiptOriginal(a1, { quantity_delta_minor: "24", ...pack("0", "24") }),
        receiptOriginal(a1, { quantity_delta_minor: "24", ...pack(`${BOUND + 1n}`, "24") }),
        receiptOriginal(a1, { quantity_delta_minor: "2", ...pack("2", "1") }),
        receiptOriginal(a1, { quantity_delta_minor: "1000000001", ...pack("1", "1000000001") }),
      ]) {
        expect(await violation(insert("inventory_movements", row))).toEqual({ code: CHECK, constraint: arithmetic });
      }
    });

    it("a count times factor beyond BIGINT is rejected cleanly as 23514, not 22003 (computed in NUMERIC)", async () => {
      const failure = await violation(
        insert(
          "inventory_movements",
          receiptOriginal(a1, { quantity_delta_minor: `${BOUND}`, ...pack(`${BOUND}`, "1000000000") }),
        ),
      );
      expect(failure).toEqual({ code: CHECK, constraint: arithmetic });
      const { rows } = await harness.owner.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1`,
        [arithmetic],
      );
      const definition = rows[0]?.definition ?? "";
      expect(definition).toContain("abs((quantity_delta_minor)::numeric)");
      expect(definition).not.toMatch(/double|real|float/i);
    });
  });

  describe("balances", () => {
    async function lastMovement(variantId: string) {
      const row = receiptOriginal(variantId);
      await insert("inventory_movements", row);
      return row["id"] as string;
    }
    const balance = (variantId: string, extra: Row = {}): Row => ({
      business_id: a.businessId,
      location_id: a.locationId,
      variant_id: variantId,
      quantity_minor: "0",
      version: 0,
      last_movement_id: null,
      updated_at: AT,
      ...extra,
    });

    it("accepts an empty version-0 row and a negative balance (no non-negative CHECK)", async () => {
      await insert("inventory_balances", balance(a1));
      await insert(
        "inventory_balances",
        balance(a2, { quantity_minor: "-3", version: 1, last_movement_id: await lastMovement(a2) }),
      );
    });

    it("rejects out-of-range quantities, a negative version and inconsistent empty rows (23514)", async () => {
      const last = await lastMovement(a1);
      await rejects(
        "inventory_balances",
        balance(a1, { quantity_minor: `${BOUND + 1n}`, version: 1, last_movement_id: last }),
        CHECK,
        "inventory_balances_quantity_range",
      );
      await rejects(
        "inventory_balances",
        balance(a1, { version: -1, last_movement_id: last }),
        CHECK,
        "inventory_balances_version_non_negative",
      );
      await rejects("inventory_balances", balance(a1, { version: 1 }), CHECK, "inventory_balances_last_movement_shape");
      await rejects(
        "inventory_balances",
        balance(a1, { quantity_minor: "5" }),
        CHECK,
        "inventory_balances_empty_is_zero",
      );
    });

    it("the last movement belongs to the same stock item; one row per stock item; no cross-tenant variant", async () => {
      const otherVariant = await lastMovement(a2);
      await rejects(
        "inventory_balances",
        balance(a1, { quantity_minor: "5", version: 1, last_movement_id: otherVariant }),
        FOREIGN_KEY,
        "inventory_balances_last_movement_fkey",
      );
      await insert("inventory_balances", balance(a1));
      await rejects("inventory_balances", balance(a1), UNIQUE, "inventory_balances_pkey");
      await rejects("inventory_balances", balance(b1), FOREIGN_KEY);
    });
  });

  describe("thresholds", () => {
    const threshold = (variantId: string, extra: Row = {}): Row => ({
      business_id: a.businessId,
      id: newId(),
      location_id: a.locationId,
      variant_id: variantId,
      low_stock_threshold_minor: "5",
      version: 1,
      created_at: AT,
      updated_at: AT,
      ...extra,
    });

    it("accepts NULL (cleared), 0 and 10^15", async () => {
      await insert("inventory_stock_thresholds", threshold(a1, { low_stock_threshold_minor: null }));
      await insert("inventory_stock_thresholds", threshold(a2, { low_stock_threshold_minor: "0" }));
      const elsewhere = await secondLocation(harness, a.businessId);
      await insert(
        "inventory_stock_thresholds",
        threshold(a1, { location_id: elsewhere, low_stock_threshold_minor: `${BOUND}` }),
      );
    });

    it("rejects out-of-range values, version 0, an update before creation, a duplicate and a foreign variant", async () => {
      const range = "inventory_stock_thresholds_threshold_range";
      await rejects("inventory_stock_thresholds", threshold(a1, { low_stock_threshold_minor: "-1" }), CHECK, range);
      await rejects(
        "inventory_stock_thresholds",
        threshold(a1, { low_stock_threshold_minor: `${BOUND + 1n}` }),
        CHECK,
        range,
      );
      await rejects(
        "inventory_stock_thresholds",
        threshold(a1, { version: 0 }),
        CHECK,
        "inventory_stock_thresholds_version_positive",
      );
      await rejects(
        "inventory_stock_thresholds",
        threshold(a1, { updated_at: "2026-10-01T07:00:00.000Z" }),
        CHECK,
        "inventory_stock_thresholds_updated_after_created",
      );
      await insert("inventory_stock_thresholds", threshold(a1));
      await rejects("inventory_stock_thresholds", threshold(a1), UNIQUE, "inventory_stock_thresholds_stock_item_key");
      await rejects("inventory_stock_thresholds", threshold(b1), FOREIGN_KEY);
    });
  });

  describe("document headers", () => {
    it("rejects invalid recording fields and notes on every header table", async () => {
      const tables: [string, (extra: Row) => Row][] = [
        ["inventory_opening_batches", (extra) => header(a, extra)],
        ["goods_receipts", (extra) => receiptRow(a, extra)],
        ["inventory_adjustments", (extra) => adjustmentRow(a, "ADJUSTMENT", "FOUND_STOCK", extra)],
      ];
      for (const [table, row] of tables) {
        await rejects(table, row({ source_channel: "fax" }), CHECK, `${table}_source_channel_valid`);
        await rejects(table, row({ correlation_id: "" }), CHECK, `${table}_correlation_id_format`);
        await rejects(
          table,
          row({ recorded_at: "2026-10-01T07:00:00.000Z" }),
          CHECK,
          `${table}_recorded_after_occurred`,
        );
        for (const note of ["", "   ", " x", "x ", "n".repeat(501)]) {
          await rejects(table, row({ note }), CHECK, `${table}_note_valid`);
        }
        await insert(table, row({ note: "n".repeat(500) }));
        await rejects(table, row({ location_id: b.locationId }), FOREIGN_KEY);
        await rejects(table, row({ actor_membership_id: b.membershipId }), FOREIGN_KEY);
      }
    });

    it("goods receipts: reference shape, status and the reversal columns together", async () => {
      for (const reference of ["", " INV-1", "INV-1 ", "r".repeat(65)]) {
        await rejects("goods_receipts", receiptRow(a, { reference }), CHECK, "goods_receipts_reference_valid");
      }
      await insert("goods_receipts", receiptRow(a, { reference: "r".repeat(64) }));
      await rejects("goods_receipts", receiptRow(a, { status: "VOID" }), CHECK, "goods_receipts_status_valid");
      const reversed = {
        reversed_at: AT,
        reversed_by_membership_id: a.membershipId,
        reversal_reason: "Wrong delivery",
      };
      await rejects("goods_receipts", receiptRow(a, { status: "REVERSED" }), CHECK, "goods_receipts_reversed_shape");
      await rejects("goods_receipts", receiptRow(a, reversed), CHECK, "goods_receipts_reversed_shape");
      await rejects(
        "goods_receipts",
        receiptRow(a, { status: "REVERSED", ...reversed, reversal_reason: null }),
        CHECK,
        "goods_receipts_reversed_shape",
      );
      await rejects(
        "goods_receipts",
        receiptRow(a, { status: "REVERSED", ...reversed, reversal_reason: " Wrong" }),
        CHECK,
        "goods_receipts_reversal_reason_valid",
      );
      await rejects(
        "goods_receipts",
        receiptRow(a, { status: "REVERSED", ...reversed, reversed_by_membership_id: b.membershipId }),
        FOREIGN_KEY,
      );
      await insert("goods_receipts", receiptRow(a, { status: "REVERSED", ...reversed }));
    });

    it("adjustments: kind, the kind's reason list, OTHER needs a note, and the reason note shape", async () => {
      expect((await violation(insert("inventory_adjustments", adjustmentRow(a, "COUNT", "FOUND_STOCK")))).code).toBe(
        CHECK,
      );
      await rejects(
        "inventory_adjustments",
        adjustmentRow(a, "ADJUSTMENT", "DAMAGED"),
        CHECK,
        "inventory_adjustments_reason_valid",
      );
      await rejects(
        "inventory_adjustments",
        adjustmentRow(a, "WRITE_OFF", "FOUND_STOCK"),
        CHECK,
        "inventory_adjustments_reason_valid",
      );
      await rejects(
        "inventory_adjustments",
        adjustmentRow(a, "WRITE_OFF", "OTHER"),
        CHECK,
        "inventory_adjustments_other_requires_note",
      );
      for (const reasonNote of ["", "   ", " Leak", "Leak ", "x".repeat(501)]) {
        await rejects(
          "inventory_adjustments",
          adjustmentRow(a, "WRITE_OFF", "OTHER", { reason_note: reasonNote }),
          CHECK,
          "inventory_adjustments_reason_note_valid",
        );
      }
      await insert("inventory_adjustments", adjustmentRow(a, "WRITE_OFF", "OTHER", { reason_note: "x" }));
      await insert("inventory_adjustments", adjustmentRow(a, "ADJUSTMENT", "OTHER", { reason_note: "y".repeat(500) }));
    });
  });

  describe("application-role privileges (plan section 35)", () => {
    it("DELETE and TRUNCATE are denied on all six tables", async () => {
      for (const table of INVENTORY_TABLES) {
        expect(await sqlState(app.query(`DELETE FROM ${table} WHERE false`))).toBe(INSUFFICIENT_PRIVILEGE);
        expect(await sqlState(app.query(`TRUNCATE ${table}`))).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });

    it("movements and opening batches are never updated; balances and thresholds are", async () => {
      expect(await sqlState(app.query(`UPDATE inventory_movements SET type = type WHERE false`))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await sqlState(app.query(`UPDATE inventory_opening_batches SET note = note WHERE false`))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      await app.query(`UPDATE inventory_balances SET quantity_minor = quantity_minor WHERE false`);
      await app.query(`UPDATE inventory_stock_thresholds SET version = version WHERE false`);
    });

    it("headers: only the four reversal columns are updatable, and FOR UPDATE works under the column grant", async () => {
      for (const table of ["goods_receipts", "inventory_adjustments"]) {
        for (const column of REVERSAL_COLUMNS) {
          await app.query(`UPDATE ${table} SET "${column}" = "${column}" WHERE false`);
        }
        for (const column of ["note", "location_id", "business_id", "occurred_at", "actor_membership_id"]) {
          expect(await sqlState(app.query(`UPDATE ${table} SET "${column}" = "${column}" WHERE false`))).toBe(
            INSUFFICIENT_PRIVILEGE,
          );
        }
      }
      expect(await sqlState(app.query(`UPDATE inventory_adjustments SET reason_code = reason_code WHERE false`))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await sqlState(app.query(`UPDATE goods_receipts SET reference = reference WHERE false`))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        const receipt = await client.query(`SELECT id FROM goods_receipts WHERE id = $1 FOR UPDATE`, [docs.receipt]);
        const adjustment = await client.query(`SELECT id FROM inventory_adjustments WHERE id = $1 FOR UPDATE`, [
          docs.adjustment,
        ]);
        expect([receipt.rowCount, adjustment.rowCount]).toEqual([1, 1]);
        expect(
          await sqlState(
            harness.owner.query(`SELECT id FROM goods_receipts WHERE id = $1 FOR UPDATE NOWAIT`, [docs.receipt]),
          ),
        ).toBe("55P03");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("the application role may insert inventory rows", async () => {
      await insert("goods_receipts", receiptRow(a), app);
      await insert("inventory_movements", receiptOriginal(a1), app);
    });
  });
});
