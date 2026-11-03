import { ConflictError, parsePageRequest, presentSale, type TransactionScope } from "@tali/application";
import { parseSaleId, type Sale } from "@tali/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { readSalesConsistency } from "../../src/testing/index.js";
import { type InventoryTenant, inventoryTenant, rejection, secondLocation } from "../support/inventory.js";
import { pricedProduct, reversalInput, type SaleProduct, saleInput, saleLine } from "../support/sales.js";
import { type Tenancy, useTenancyHarness } from "../support/tenancy.js";

/**
 * ZT. The PostgreSQL sale adapters (ADR-011; Plan 005 S5): SaleRepository
 * reads are business scoped and restore exactly what the use case recorded,
 * failing closed on a stored row that no longer agrees with the domain;
 * markReversed only moves a POSTED sale; the receipt issuer creates its
 * counter lazily and rolls back with its transaction.
 */
describe("ZT. sale repositories (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const sales = harness.repositories.sales;
  const run = <T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> => harness.unitOfWork.run(work);

  let tenancy: Tenancy;
  let a: InventoryTenant;
  let b: InventoryTenant;
  let soap: SaleProduct;
  let bSoap: SaleProduct;

  const sell = (t: InventoryTenant, item: SaleProduct, quantity = "1") =>
    tenancy.recordSale.execute(
      t.context,
      saleInput(harness, t, [saleLine(item, quantity)], (50_000n * BigInt(quantity)).toString()),
    );
  const find = (t: InventoryTenant, saleId: string) =>
    run((scope) => sales.findById(scope, t.businessId, parseSaleId(saleId)));

  beforeEach(async () => {
    tenancy = harness.compose();
    a = await inventoryTenant(harness, "sale-repo-a");
    b = await inventoryTenant(harness, "sale-repo-b");
    soap = await pricedProduct(harness, a, { name: "Soap", quantity: "20", totalCost: "70000" });
    bSoap = await pricedProduct(harness, b, { name: "Soap", quantity: "20", totalCost: "70000" });
  });

  it("restores a recorded sale exactly: header, lines, tenders and stock effects", async () => {
    const sugar = await pricedProduct(harness, a, { name: "Sugar", quantity: "3" });
    const bag = await pricedProduct(harness, a, { name: "Bag", tracked: false, price: "2000" });
    const recorded = await tenancy.recordSale.execute(
      a.context,
      saleInput(harness, a, [saleLine(soap, "2"), saleLine(sugar, "1"), saleLine(bag, "1")], "152000"),
    );
    const restored = await find(a, recorded.sale.saleId);
    expect(restored).toBeDefined();
    expect(presentSale(restored as Sale, true)).toEqual(recorded.sale);
    expect(restored?.costStatus).toBe("PARTIAL");
    expect(restored?.stockEffects.map((effect) => [effect.lineNumber, effect.costStatus])).toEqual([
      [1, "VALUED"],
      [2, "UNVALUED"],
    ]);
    const locked = await run((scope) =>
      sales.findByIdForUpdate(scope, a.businessId, parseSaleId(recorded.sale.saleId)),
    );
    expect(locked).toEqual(restored);
  });

  it("finds, locks and lists only inside the caller's business and location", async () => {
    const first = await sell(a, soap);
    const second = await sell(a, soap);
    const foreign = await sell(b, bSoap);
    expect(await find(b, first.sale.saleId)).toBeUndefined();
    expect(await find(a, foreign.sale.saleId)).toBeUndefined();
    expect(
      await run((scope) => sales.findByIdForUpdate(scope, b.businessId, parseSaleId(first.sale.saleId))),
    ).toBeUndefined();

    const list = (t: InventoryTenant, locationId = t.locationId, limit = 10, after?: string) =>
      run((scope) =>
        sales.list(scope, t.businessId, {
          locationId,
          page: parsePageRequest({ limit, ...(after === undefined ? {} : { after }) }),
        }),
      );
    const ids = [first.sale.saleId, second.sale.saleId].sort();
    expect((await list(a)).items.map((sale) => sale.id)).toEqual(ids);
    const page1 = await list(a, a.locationId, 1);
    expect(page1.items.map((sale) => sale.id)).toEqual([ids[0]]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await list(a, a.locationId, 1, page1.nextCursor ?? undefined);
    expect(page2.items.map((sale) => sale.id)).toEqual([ids[1]]);
    expect((await list(b)).items.map((sale) => sale.id)).toEqual([foreign.sale.saleId]);
    expect((await list(a, b.locationId)).items).toEqual([]);
    expect((await list(a, await secondLocation(harness, a.businessId))).items).toEqual([]);

    const byOther = await run((scope) =>
      sales.list(scope, a.businessId, {
        locationId: a.locationId,
        recordedByMembershipId: b.membershipId,
        page: parsePageRequest({}),
      }),
    );
    expect(byOther.items).toEqual([]);
  });

  it("a duplicate insert is a CONFLICT and writes nothing", async () => {
    const recorded = await sell(a, soap);
    const stored = await find(a, recorded.sale.saleId);
    if (stored === undefined) throw new Error("expected the sale");
    expect(await rejection(run((scope) => sales.insert(scope, stored)))).toBeInstanceOf(ConflictError);
    const { rows } = await harness.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM sales`);
    expect(rows[0]?.n).toBe(1);
  });

  it("markReversed moves a POSTED sale only once", async () => {
    const recorded = await sell(a, soap);
    await tenancy.reverseSale.execute(a.context, reversalInput(harness, recorded.sale.saleId));
    const reversed = await find(a, recorded.sale.saleId);
    expect(reversed?.status).toBe("REVERSED");
    expect(await rejection(run((scope) => sales.markReversed(scope, reversed as Sale)))).toBeInstanceOf(ConflictError);
    expect((await find(a, recorded.sale.saleId))?.reversedAt).toEqual(reversed?.reversedAt);
  });

  it("the receipt issuer creates its counter lazily, numbers per business, and rolls back with its transaction", async () => {
    const counter = async (t: InventoryTenant) =>
      (
        await harness.owner.query<{ next: string }>(
          `SELECT next_number::text AS next FROM sale_receipt_sequences WHERE business_id = $1`,
          [t.businessId],
        )
      ).rows[0]?.next;
    expect(await counter(a)).toBeUndefined();
    const issuer = harness.repositories.saleReceiptNumbers;
    expect(await run((scope) => issuer.issue(scope, a.businessId))).toBe("S-000001");
    expect(await run((scope) => issuer.issue(scope, a.businessId))).toBe("S-000002");
    expect(await run((scope) => issuer.issue(scope, b.businessId))).toBe("S-000001");
    expect(
      await rejection(
        run(async (scope) => {
          await issuer.issue(scope, a.businessId);
          throw new Error("abandon the sale");
        }),
      ),
    ).toBeInstanceOf(Error);
    expect(await counter(a)).toBe("3");
    expect(await run((scope) => issuer.issue(scope, a.businessId))).toBe("S-000003");
  });

  describe("restoration fails closed", () => {
    const tampering: [string, string][] = [
      ["a header total", `UPDATE sales SET total_minor = total_minor + 1`],
      ["a cost snapshot", `UPDATE sale_lines SET cost_minor = cost_minor + 1`],
      ["a line amount", `UPDATE sale_lines SET net_minor = net_minor - 1, taxable_base_minor = taxable_base_minor - 1`],
      ["a tender amount", `UPDATE sale_tenders SET amount_minor = amount_minor + 1`],
      [
        "a movement quantity",
        `UPDATE inventory_movements SET quantity_delta_minor = quantity_delta_minor - 1 WHERE sale_id IS NOT NULL`,
      ],
      [
        "a valuation fact",
        `UPDATE inventory_movement_valuations SET value_delta_minor = value_delta_minor - 1
         WHERE movement_id IN (SELECT id FROM inventory_movements WHERE sale_id IS NOT NULL)`,
      ],
      [
        "a valuation fact basis",
        `UPDATE inventory_movement_valuations SET cost_basis = 'NOT_VALUED', value_delta_minor = 0, journal_entry_id = NULL
         WHERE movement_id IN (SELECT id FROM inventory_movements WHERE sale_id IS NOT NULL)`,
      ],
      ["the COGS total", `UPDATE sales SET cogs_total_minor = cogs_total_minor + 1`],
    ];
    for (const [label, sql] of tampering) {
      it(`a stored sale whose ${label} was changed is not restored`, async () => {
        const recorded = await sell(a, soap, "2");
        const changed = await harness.owner.query(sql);
        expect(changed.rowCount).toBe(1);
        const failure = await rejection(find(a, recorded.sale.saleId));
        expect(String(failure)).toMatch(/stored sale .* is inconsistent/);
        expect((await readSalesConsistency()).length).toBeGreaterThan(0);
      });
    }
  });
});
