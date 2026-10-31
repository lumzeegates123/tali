import { ValidationError, type TransactionScope } from "@tali/application";
import { Money } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { readLedgerConsistency } from "../../src/testing/index.js";
import { inventoryProduct, inventoryTenant } from "../support/inventory.js";
import { useTenancyHarness } from "../support/tenancy.js";

/**
 * ZM. The PostgreSQL JournalRepository (ADR-009 section 13): tenant-scoped
 * reads, one original per typed source, and sale sources rejected until S5.
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

  it("rejects a sale journal source until the sales slice", async () => {
    const a = await inventoryTenant(harness, "journal-sale");
    const amount = Money.ofMinor(50n, a.currency);
    const inventory = await run((scope) =>
      harness.repositories.ledgerAccounts.findByRole(scope, a.businessId, "INVENTORY"),
    );
    const equity = await run((scope) =>
      harness.repositories.ledgerAccounts.findByRole(scope, a.businessId, "OPENING_BALANCE_EQUITY"),
    );
    if (inventory === undefined || equity === undefined) throw new Error("expected a provisioned chart");
    await expect(
      run((scope) =>
        journals.insert(scope, {
          id: harness.world().ids.newId("JournalEntry"),
          businessId: a.businessId,
          currency: a.currency,
          occurredAt: harness.world().clock.now(),
          businessDate: "2026-10-18",
          recordedAt: harness.world().clock.now(),
          entryKind: "ORIGINAL",
          source: { kind: "sale", id: harness.world().ids.newId("Row") },
          postingRule: "SALE_POSTED",
          postingRuleVersion: 1,
          description: "sale posting",
          sourceChannel: a.context.sourceChannel,
          correlationId: a.context.correlationId,
          lines: [
            {
              lineNumber: 1,
              accountId: inventory.id,
              systemRole: "INVENTORY",
              direction: "DEBIT",
              amount,
            },
            {
              lineNumber: 2,
              accountId: equity.id,
              systemRole: "OPENING_BALANCE_EQUITY",
              direction: "CREDIT",
              amount,
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
