import {
  ConflictError,
  IdempotencyKeyReusedError,
  InsufficientStockError,
  type LocationBoundContext,
  NotFoundError,
  PermissionDeniedError,
} from "@tali/application";
import type { MembershipRole } from "@tali/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInventoryConsistency, readLedgerConsistency, readSalesConsistency } from "../../src/testing/index.js";
import { type InventoryTenant, inventoryTenant, rejection, secondLocation } from "../support/inventory.js";
import { pricedProduct, reversalInput, type SaleProduct, saleInput, saleLine } from "../support/sales.js";
import { type Tenancy, useTenancyHarness } from "../support/tenancy.js";

/**
 * ZU. RecordSale and ReverseSale composed over PostgreSQL with the NO_TAX
 * resolver and no HTTP (ADR-011; Plan 005 S5): stock, valuation, journal,
 * receipt and audit effects in one transaction; idempotent replay; the
 * read scope of each role; reversal by mirrored compensating records. Every
 * test ends with the ledger, inventory and sales consistency checks clean.
 */
describe("ZU. sales use cases (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  let tenancy: Tenancy;
  let a: InventoryTenant;
  let b: InventoryTenant;

  const sell = (context: LocationBoundContext, item: SaleProduct, quantity = "1", price = 50_000n) =>
    tenancy.recordSale.execute(
      context,
      saleInput(harness, context, [saleLine(item, quantity)], (price * BigInt(quantity)).toString()),
    );
  const reverse = (context: LocationBoundContext, saleId: string, idempotencyKey?: string) =>
    tenancy.reverseSale.execute(
      context,
      reversalInput(harness, saleId, idempotencyKey === undefined ? {} : { idempotencyKey }),
    );

  async function stock(t: InventoryTenant, item: SaleProduct) {
    const { rows } = await harness.owner.query<{ quantity: string; value: string; status: string; version: number }>(
      `SELECT b.quantity_minor::text AS quantity, v.value_minor::text AS value, v.status, v.version
       FROM inventory_balances b JOIN inventory_valuations v USING (business_id, location_id, variant_id)
       WHERE b.business_id = $1 AND b.variant_id = $2`,
      [t.businessId, item.variantId],
    );
    return rows[0];
  }

  async function movements(saleId: string) {
    const { rows } = await harness.owner.query<{
      id: string;
      variant: string;
      delta: string;
      after: string;
      reverses: string | null;
      basis: string;
      value: string;
      journal: string | null;
    }>(
      `SELECT m.id, m.variant_id AS variant, m.quantity_delta_minor::text AS delta,
              m.balance_after_minor::text AS after, m.reverses_movement_id AS reverses,
              f.cost_basis AS basis, f.value_delta_minor::text AS value, f.journal_entry_id AS journal
       FROM inventory_movements m JOIN inventory_movement_valuations f
         ON f.business_id = m.business_id AND f.movement_id = m.id
       WHERE m.sale_id = $1 AND m.type = 'SALE'
       ORDER BY m.balance_version, m.reverses_movement_id NULLS FIRST`,
      [saleId],
    );
    return rows;
  }

  async function postings(journalEntryId: string | undefined) {
    const { rows } = await harness.owner.query<{ role: string; direction: string; amount: string }>(
      `SELECT a.system_role AS role, l.direction, l.amount_minor::text AS amount
       FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1 ORDER BY l.line_number`,
      [journalEntryId],
    );
    return rows.map((row) => `${row.direction} ${row.role} ${row.amount}`).sort();
  }

  async function journalsOf(saleId: string) {
    const { rows } = await harness.owner.query<{ id: string; kind: string; reverses: string | null }>(
      `SELECT id, entry_kind AS kind, reverses_entry_id AS reverses FROM journal_entries
       WHERE sale_id = $1 ORDER BY entry_kind`,
      [saleId],
    );
    return rows;
  }

  async function audits(saleId: string) {
    const { rows } = await harness.owner.query<{ action: string; reason: string | null; payload: unknown }>(
      `SELECT action, reason, payload FROM business_audit_records WHERE entity_id = $1 ORDER BY occurred_at, action`,
      [saleId],
    );
    return rows;
  }

  async function counter(t: InventoryTenant): Promise<string | undefined> {
    const { rows } = await harness.owner.query<{ next: string }>(
      `SELECT next_number::text AS next FROM sale_receipt_sequences WHERE business_id = $1`,
      [t.businessId],
    );
    return rows[0]?.next;
  }

  async function member(t: InventoryTenant, subject: string, role: MembershipRole): Promise<LocationBoundContext> {
    const user = await tenancy.registeredUser(subject);
    await harness.addMember(t.businessId, user, role);
    return tenancy.boundContextFor(user, t.businessId);
  }

  beforeEach(async () => {
    tenancy = harness.compose();
    a = await inventoryTenant(harness, "sales-a");
    b = await inventoryTenant(harness, "sales-b");
  });

  afterEach(async () => {
    expect(await readLedgerConsistency()).toEqual([]);
    expect(await readInventoryConsistency()).toEqual([]);
    expect(await readSalesConsistency()).toEqual([]);
  });

  describe("recording", () => {
    it("a valued sale moves stock at weighted average cost and posts SALE_POSTED in one transaction", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "10", totalCost: "350000" });
      const before = await stock(a, soap);
      const { sale, replayed } = await sell(a.context, soap, "2");
      expect(replayed).toBe(false);
      expect(sale).toMatchObject({
        receiptNumber: "S-000001",
        status: "POSTED",
        currency: a.currency,
        grossTotalMinor: "100000",
        discountTotalMinor: "0",
        taxTotalMinor: "0",
        totalMinor: "100000",
        costStatus: "VALUED",
        cogsTotalMinor: "70000",
        recordedByMembershipId: a.membershipId,
      });
      expect(sale.lines).toHaveLength(1);
      expect(sale.lines[0]).toMatchObject({ costStatus: "VALUED", costMinor: "70000", taxKind: "NONE" });

      expect(await stock(a, soap)).toEqual({
        quantity: "8",
        value: "280000",
        status: "VALUED",
        version: (before?.version ?? 0) + 1,
      });
      expect(await movements(sale.saleId)).toEqual([
        {
          id: sale.lines[0]?.movementId,
          variant: soap.variantId,
          delta: "-2",
          after: "8",
          reverses: null,
          basis: "WEIGHTED_AVERAGE",
          value: "-70000",
          journal: sale.journalEntryId,
        },
      ]);
      expect(await journalsOf(sale.saleId)).toEqual([{ id: sale.journalEntryId, kind: "ORIGINAL", reverses: null }]);
      expect(await postings(sale.journalEntryId)).toEqual(
        [
          "DEBIT CASH_ON_HAND 100000",
          "CREDIT SALES_REVENUE 100000",
          "DEBIT COST_OF_GOODS_SOLD 70000",
          "CREDIT INVENTORY 70000",
        ].sort(),
      );
      const recorded = await audits(sale.saleId);
      expect(recorded.map((row) => row.action)).toEqual(["sale.recorded"]);
      expect(JSON.stringify(recorded[0]?.payload)).not.toContain("lines");
    });

    it("an unvalued sale moves stock with a NOT_VALUED fact and posts no COGS", async () => {
      const salt = await pricedProduct(harness, a, { name: "Salt", quantity: "5" });
      const { sale } = await sell(a.context, salt, "2");
      expect(sale).toMatchObject({ costStatus: "UNVALUED", cogsTotalMinor: "0" });
      expect(sale.lines[0]).toMatchObject({ costStatus: "UNVALUED" });
      expect(sale.lines[0]?.costMinor).toBeUndefined();
      expect(await stock(a, salt)).toMatchObject({ quantity: "3", value: "0", status: "UNVALUED" });
      expect(await movements(sale.saleId)).toEqual([
        expect.objectContaining({ delta: "-2", basis: "NOT_VALUED", value: "0", journal: null }),
      ]);
      expect(await postings(sale.journalEntryId)).toEqual(
        ["DEBIT CASH_ON_HAND 100000", "CREDIT SALES_REVENUE 100000"].sort(),
      );
    });

    it("an untracked product sells without a movement, with cost NOT_APPLICABLE", async () => {
      const bag = await pricedProduct(harness, a, { name: "Bag", tracked: false, price: "2000" });
      const { sale } = await sell(a.context, bag, "3", 2_000n);
      expect(sale).toMatchObject({ totalMinor: "6000", costStatus: "NOT_APPLICABLE", cogsTotalMinor: "0" });
      expect(sale.lines[0]).toMatchObject({ tracked: false, costStatus: "NOT_APPLICABLE" });
      expect(sale.lines[0]?.movementId).toBeUndefined();
      expect(await movements(sale.saleId)).toEqual([]);
      expect(await postings(sale.journalEntryId)).toEqual(
        ["DEBIT CASH_ON_HAND 6000", "CREDIT SALES_REVENUE 6000"].sort(),
      );
    });

    it("a repeated variant chains its movements: 3 valued at 100 sold as 2 then 1 cost 67 then 33", async () => {
      const gum = await pricedProduct(harness, a, { name: "Gum", quantity: "3", totalCost: "100", price: "500" });
      const before = await stock(a, gum);
      const { sale } = await tenancy.recordSale.execute(
        a.context,
        saleInput(harness, a, [saleLine(gum, "2"), saleLine(gum, "1")], "1500"),
      );
      expect(sale.lines.map((line) => line.costMinor)).toEqual(["67", "33"]);
      expect(sale.cogsTotalMinor).toBe("100");
      expect(new Set(sale.lines.map((line) => line.movementId)).size).toBe(2);
      expect((await movements(sale.saleId)).map((row) => [row.delta, row.after, row.value])).toEqual([
        ["-2", "1", "-67"],
        ["-1", "0", "-33"],
      ]);
      expect(await stock(a, gum)).toMatchObject({ quantity: "0", value: "0", version: (before?.version ?? 0) + 2 });
      expect(await postings(sale.journalEntryId)).toEqual(
        [
          "DEBIT CASH_ON_HAND 1500",
          "CREDIT SALES_REVENUE 1500",
          "DEBIT COST_OF_GOODS_SOLD 100",
          "CREDIT INVENTORY 100",
        ].sort(),
      );
    });

    it("a discounted sale posts gross revenue and the discount separately", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "10", totalCost: "350000" });
      const { sale } = await tenancy.recordSale.execute(
        a.context,
        saleInput(
          harness,
          a,
          [saleLine(soap, "2", { discount: { kind: "FIXED", amount: { amountMinor: "5000", currency: a.currency } } })],
          "95000",
        ),
      );
      expect(sale).toMatchObject({ grossTotalMinor: "100000", discountTotalMinor: "5000", totalMinor: "95000" });
      expect(await postings(sale.journalEntryId)).toEqual(
        [
          "DEBIT CASH_ON_HAND 95000",
          "DEBIT SALES_DISCOUNTS 5000",
          "CREDIT SALES_REVENUE 100000",
          "DEBIT COST_OF_GOODS_SOLD 70000",
          "CREDIT INVENTORY 70000",
        ].sort(),
      );
    });

    it("selling more than is on hand is INSUFFICIENT_STOCK and writes nothing", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "1", totalCost: "35000" });
      const before = await stock(a, soap);
      expect(await rejection(sell(a.context, soap, "2"))).toBeInstanceOf(InsufficientStockError);
      expect(await stock(a, soap)).toEqual(before);
      const { rows } = await harness.owner.query(`SELECT 1 FROM sales WHERE business_id = $1`, [a.businessId]);
      expect(rows).toEqual([]);
    });
  });

  describe("receipt numbers", () => {
    it("numbers per business, does not advance on replay, and a failed sale leaves the counter alone", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "5", totalCost: "175000" });
      const bSoap = await pricedProduct(harness, b, { name: "Soap", quantity: "5", totalCost: "175000" });
      const input = saleInput(harness, a, [saleLine(soap, "1")], "50000");
      const first = await tenancy.recordSale.execute(a.context, input);
      expect(first.sale.receiptNumber).toBe("S-000001");
      const replay = await tenancy.recordSale.execute(a.context, input);
      expect(replay).toEqual({ sale: first.sale, replayed: true });
      expect(await counter(a)).toBe("2");

      expect((await sell(b.context, bSoap)).sale.receiptNumber).toBe("S-000001");

      expect(await rejection(sell(a.context, soap, "99"))).toBeInstanceOf(InsufficientStockError);
      expect(await counter(a)).toBe("2");
      expect((await sell(a.context, soap)).sale.receiptNumber).toBe("S-000002");
      expect(await counter(a)).toBe("3");
    });
  });

  describe("idempotency", () => {
    it("replays the same key and body without new effects", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "5", totalCost: "175000" });
      const input = saleInput(harness, a, [saleLine(soap, "2")], "100000");
      const first = await tenancy.recordSale.execute(a.context, input);
      const afterFirst = await stock(a, soap);
      const replay = await tenancy.recordSale.execute(a.context, input);
      expect(replay.replayed).toBe(true);
      expect(replay.sale).toEqual(first.sale);
      expect(await stock(a, soap)).toEqual(afterFirst);
      expect(await movements(first.sale.saleId)).toHaveLength(1);
      expect((await audits(first.sale.saleId)).map((row) => row.action)).toEqual(["sale.recorded"]);
    });

    it("the same key with a changed body is IDEMPOTENCY_KEY_REUSED and writes nothing", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "5", totalCost: "175000" });
      const input = saleInput(harness, a, [saleLine(soap, "2")], "100000");
      await tenancy.recordSale.execute(a.context, input);
      const before = await stock(a, soap);
      expect(
        await rejection(
          tenancy.recordSale.execute(a.context, {
            ...input,
            lines: [saleLine(soap, "1")],
            tenders: [{ method: "CASH", amount: { amountMinor: "50000", currency: a.currency } }],
          }),
        ),
      ).toBeInstanceOf(IdempotencyKeyReusedError);
      expect(await stock(a, soap)).toEqual(before);
      expect(await counter(a)).toBe("2");
    });

    it("concurrent requests with the same key record one sale and replay the other", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "5", totalCost: "175000" });
      const input = saleInput(harness, a, [saleLine(soap, "2")], "100000");
      const results = await Promise.all([0, 1].map(() => tenancy.recordSale.execute(a.context, input)));
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(results[0]?.sale).toEqual(results[1]?.sale);
      expect(await stock(a, soap)).toMatchObject({ quantity: "3" });
      expect(await counter(a)).toBe("2");
    });
  });

  describe("read scope", () => {
    it("OWNER, MANAGER and ACCOUNTANT read every sale at the location with cost", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "5", totalCost: "175000" });
      const cashier = await member(a, "sales-cashier", "CASHIER");
      const owned = await sell(a.context, soap);
      const rung = await sell(cashier, soap);
      for (const [subject, role] of [
        ["sales-manager", "MANAGER"],
        ["sales-accountant", "ACCOUNTANT"],
      ] as const) {
        const reader = await member(a, subject, role);
        const read = await tenancy.getSale.execute(reader, rung.sale.saleId);
        expect(read).toMatchObject({ saleId: rung.sale.saleId, costStatus: "VALUED", cogsTotalMinor: "35000" });
        const listed = await tenancy.listSales.execute(reader, { limit: 10 });
        expect(listed.items.map((sale) => sale.saleId).sort()).toEqual([owned.sale.saleId, rung.sale.saleId].sort());
      }
      expect((await tenancy.listSales.execute(a.context)).items).toHaveLength(2);
    });

    it("a CASHIER reads only their own sales, without cost; another cashier's sale is NOT_FOUND", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "5", totalCost: "175000" });
      const cashier = await member(a, "sales-cashier-1", "CASHIER");
      const other = await member(a, "sales-cashier-2", "CASHIER");
      const own = await sell(cashier, soap);
      expect(own.sale.costStatus).toBeUndefined();
      expect(own.sale.cogsTotalMinor).toBeUndefined();
      expect(own.sale.lines[0]?.costMinor).toBeUndefined();
      const theirs = await sell(other, soap);
      await sell(a.context, soap);

      const read = await tenancy.getSale.execute(cashier, own.sale.saleId);
      expect(read).toEqual(own.sale);
      expect(await rejection(tenancy.getSale.execute(cashier, theirs.sale.saleId))).toBeInstanceOf(NotFoundError);
      expect((await tenancy.listSales.execute(cashier)).items.map((sale) => sale.saleId)).toEqual([own.sale.saleId]);
    });

    it("a sale is NOT_FOUND at another location and in another business", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "5", totalCost: "175000" });
      const { sale } = await sell(a.context, soap);
      const backStore = { ...a.context, locationId: await secondLocation(harness, a.businessId) };
      expect(await rejection(tenancy.getSale.execute(backStore, sale.saleId))).toBeInstanceOf(NotFoundError);
      expect((await tenancy.listSales.execute(backStore)).items).toEqual([]);
      expect(await rejection(tenancy.getSale.execute(b.context, sale.saleId))).toBeInstanceOf(NotFoundError);
      expect((await tenancy.listSales.execute(b.context)).items).toEqual([]);
      expect(await rejection(reverse(b.context, sale.saleId))).toBeInstanceOf(NotFoundError);
      expect(await rejection(reverse(backStore, sale.saleId))).toBeInstanceOf(NotFoundError);
    });

    it("a STOCK_KEEPER can neither read, record nor reverse sales", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "5", totalCost: "175000" });
      const { sale } = await sell(a.context, soap);
      const keeper = await member(a, "sales-keeper", "STOCK_KEEPER");
      expect(await rejection(tenancy.getSale.execute(keeper, sale.saleId))).toBeInstanceOf(PermissionDeniedError);
      expect(await rejection(tenancy.listSales.execute(keeper))).toBeInstanceOf(PermissionDeniedError);
      expect(await rejection(sell(keeper, soap))).toBeInstanceOf(PermissionDeniedError);
      expect(await rejection(reverse(keeper, sale.saleId))).toBeInstanceOf(PermissionDeniedError);
      const cashier = await member(a, "sales-cashier", "CASHIER");
      expect(await rejection(reverse(cashier, sale.saleId))).toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("reversal", () => {
    it("a valued reversal returns stock and value by mirrored movements and a REVERSAL journal", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "10", totalCost: "350000" });
      const before = await stock(a, soap);
      const { sale } = await sell(a.context, soap, "2");
      const { sale: reversed, replayed } = await reverse(a.context, sale.saleId);
      expect(replayed).toBe(false);
      expect(reversed).toMatchObject({ status: "REVERSED", reversalTenderUnwoundConfirmed: true });
      expect(reversed.reversalJournalEntryId).toBeDefined();
      expect(await stock(a, soap)).toEqual({
        quantity: "10",
        value: "350000",
        status: "VALUED",
        version: (before?.version ?? 0) + 2,
      });
      const [original, mirror] = await movements(sale.saleId);
      expect(mirror).toMatchObject({
        delta: "2",
        after: "10",
        reverses: original?.id,
        basis: "REVERSAL_OF_ORIGINAL",
        value: "70000",
        journal: reversed.reversalJournalEntryId,
      });
      expect(await journalsOf(sale.saleId)).toEqual([
        { id: sale.journalEntryId, kind: "ORIGINAL", reverses: null },
        { id: reversed.reversalJournalEntryId, kind: "REVERSAL", reverses: sale.journalEntryId },
      ]);
      expect(await postings(reversed.reversalJournalEntryId)).toEqual(
        [
          "CREDIT CASH_ON_HAND 100000",
          "DEBIT SALES_REVENUE 100000",
          "CREDIT COST_OF_GOODS_SOLD 70000",
          "DEBIT INVENTORY 70000",
        ].sort(),
      );
      const trail = await audits(sale.saleId);
      expect(trail.map((row) => row.action)).toEqual(["sale.recorded", "sale.reversed"]);
      expect(trail[1]?.reason).toBe("Customer returned the goods");
      const { rows } = await harness.owner.query(`SELECT status FROM sales WHERE id = $1`, [sale.saleId]);
      expect(rows).toEqual([{ status: "REVERSED" }]);
    });

    it("an unvalued reversal returns quantity with a NOT_VALUED fact", async () => {
      const salt = await pricedProduct(harness, a, { name: "Salt", quantity: "5" });
      const { sale } = await sell(a.context, salt, "2");
      const { sale: reversed } = await reverse(a.context, sale.saleId);
      expect(await stock(a, salt)).toMatchObject({ quantity: "5", value: "0", status: "UNVALUED" });
      expect((await movements(sale.saleId))[1]).toMatchObject({ delta: "2", basis: "NOT_VALUED", journal: null });
      expect(await postings(reversed.reversalJournalEntryId)).toEqual(
        ["CREDIT CASH_ON_HAND 100000", "DEBIT SALES_REVENUE 100000"].sort(),
      );
    });

    it("a sale of a product archived since can still be reversed", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "4", totalCost: "140000" });
      const { sale } = await sell(a.context, soap, "1");
      const { rows } = await harness.owner.query<{ version: number }>(`SELECT version FROM products WHERE id = $1`, [
        soap.product.product.id,
      ]);
      await tenancy.archiveProduct.execute(a.context, {
        productId: soap.product.product.id,
        expectedVersion: rows[0]?.version ?? 0,
      });
      const { sale: reversed } = await reverse(a.context, sale.saleId);
      expect(reversed.status).toBe("REVERSED");
      expect(await stock(a, soap)).toMatchObject({ quantity: "4", value: "140000" });
    });

    it("replays the reversal key; a new key after reversal is CONFLICT and writes nothing", async () => {
      const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "5", totalCost: "175000" });
      const { sale } = await sell(a.context, soap);
      const key = harness.world().ids.newId("IdempotencyKey");
      const first = await reverse(a.context, sale.saleId, key);
      const afterReversal = await stock(a, soap);
      const replay = await reverse(a.context, sale.saleId, key);
      expect(replay).toEqual({ sale: first.sale, replayed: true });
      expect(await rejection(reverse(a.context, sale.saleId))).toBeInstanceOf(ConflictError);
      expect(await stock(a, soap)).toEqual(afterReversal);
      expect(await movements(sale.saleId)).toHaveLength(2);
      expect((await journalsOf(sale.saleId)).map((row) => row.kind)).toEqual(["ORIGINAL", "REVERSAL"]);
      expect((await audits(sale.saleId)).map((row) => row.action)).toEqual(["sale.recorded", "sale.reversed"]);
    });
  });
});
