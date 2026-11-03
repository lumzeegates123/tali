import type { TransactionScope } from "@tali/application";
import { Money } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { readLedgerConsistency } from "../../src/testing/index.js";
import { inventoryProduct, inventoryTenant, rejection } from "../support/inventory.js";
import { pricedProduct, saleInput, saleLine } from "../support/sales.js";
import { useTenancyHarness } from "../support/tenancy.js";

/**
 * ZM. The PostgreSQL JournalRepository (ADR-009 section 13): tenant-scoped
 * reads, one original per typed source, and sale sources from S5.
 */
describe("ZM. journal repository (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const journals = harness.repositories.journals;
  const run = <T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> => harness.unitOfWork.run(work);

  it("stores a valuation original, isolates tenants, and rejects a second original for the same source", async () => {
    const tenancy = harness.compose();
    const a = await inventoryTenant(harness, "journal-repo-a");
    const b = await inventoryTenant(harness, "journal-repo-b");
    const soap = await inventoryProduct(harness, a, { name: "Soap" });
    await tenancy.recordOpeningStock.execute(a.context, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" }],
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
    const result = await tenancy.recordStockValuation.execute(a.context, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "350000", currency: "NGN" },
      reason: "Opening value",
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
    const source = { kind: "valuation" as const, id: result.valuationId };
    const original = await run((scope) => journals.findOriginalBySource(scope, a.businessId, source));
    expect(original?.source).toEqual(source);
    expect(original?.entryKind).toBe("ORIGINAL");
    expect(original?.lines).toHaveLength(2);
    if (original === undefined) throw new Error("expected original journal");
    expect(await run((scope) => journals.findOriginalBySource(scope, b.businessId, source))).toBeUndefined();
    expect(await run((scope) => journals.findById(scope, b.businessId, original.id))).toBeUndefined();

    const inventory = original.lines.find((line) => line.systemRole === "INVENTORY");
    const equity = original.lines.find((line) => line.systemRole === "OPENING_BALANCE_EQUITY");
    if (inventory === undefined || equity === undefined) throw new Error("expected opening valuation lines");
    await expect(
      run((scope) =>
        journals.insert(scope, {
          ...original,
          id: harness.world().ids.newId("JournalEntry"),
          recordedAt: harness.world().clock.now(),
        }),
      ),
    ).rejects.toThrow(/already exists/);
    expect(result.kind).toBe("INITIAL_OPENING");
    expect(await readLedgerConsistency()).toEqual([]);
  });

  it("stores a sale source (S5): found by source in its business only, one original per sale, and no foreign sale", async () => {
    const tenancy = harness.compose();
    const a = await inventoryTenant(harness, "journal-sale-a");
    const b = await inventoryTenant(harness, "journal-sale-b");
    const soap = await pricedProduct(harness, a, { name: "Soap", quantity: "5", totalCost: "1000" });
    const sold = await tenancy.recordSale.execute(a.context, saleInput(harness, a, [saleLine(soap, "1")], "50000"));
    const source = { kind: "sale" as const, id: sold.sale.saleId };
    const original = await run((scope) => journals.findOriginalBySource(scope, a.businessId, source));
    expect(original).toMatchObject({ source, entryKind: "ORIGINAL", postingRule: "SALE_POSTED" });
    if (original === undefined) throw new Error("expected the sale journal");
    expect(await run((scope) => journals.findOriginalBySource(scope, b.businessId, source))).toBeUndefined();
    expect(await run((scope) => journals.findById(scope, b.businessId, original.id))).toBeUndefined();

    await expect(
      run((scope) => journals.insert(scope, { ...original, id: harness.world().ids.newId("JournalEntry") })),
    ).rejects.toThrow(/already exists/);
    const amount = Money.ofMinor(50n, b.currency);
    const foreign = await run((scope) =>
      Promise.all([
        harness.repositories.ledgerAccounts.findByRole(scope, b.businessId, "INVENTORY"),
        harness.repositories.ledgerAccounts.findByRole(scope, b.businessId, "OPENING_BALANCE_EQUITY"),
      ]),
    );
    const [inventory, equity] = foreign;
    if (inventory === undefined || equity === undefined) throw new Error("expected a provisioned chart");
    const error = await rejection(
      run((scope) =>
        journals.insert(scope, {
          ...original,
          id: harness.world().ids.newId("JournalEntry"),
          businessId: b.businessId,
          lines: [
            { lineNumber: 1, accountId: inventory.id, systemRole: "INVENTORY", direction: "DEBIT", amount },
            { lineNumber: 2, accountId: equity.id, systemRole: "OPENING_BALANCE_EQUITY", direction: "CREDIT", amount },
          ],
        }),
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect(await run((scope) => journals.findOriginalBySource(scope, b.businessId, source))).toBeUndefined();
    expect(await readLedgerConsistency()).toEqual([]);
  });
});
