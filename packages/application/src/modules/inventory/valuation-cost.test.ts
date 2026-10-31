import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { IdempotencyKeyReusedError, PermissionDeniedError, ValidationError } from "../../errors/application-error.js";
import { createInventoryHarness } from "../../testing/inventory-harness.js";

describe("optional totalCost on opening stock and goods receipts", () => {
  async function setup(currency: "NGN" | "JPY" = "NGN") {
    const h = createInventoryHarness({
      currencies: [defineCurrency("NGN", 2), defineCurrency("JPY", 0)],
    });
    const mine = await h.businessWithRoles("Mine", currency);
    const soap = await h.product(mine.OWNER, { name: "Soap" });
    const oil = await h.product(mine.OWNER, { name: "Oil" });
    const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
    return { h, mine, soap, oil, key };
  }

  it("lets OWNER and MANAGER open with cost, posting OPENING_BALANCE_EQUITY", async () => {
    const { h, mine, soap, key } = await setup();
    const owner = await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "10",
          unit: "PIECE",
          totalCost: { amountMinor: "350000", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    expect(h.inventory.valuations[0]?.status).toBe("VALUED");
    expect(h.ledger.entries).toHaveLength(1);
    expect(h.ledger.entries[0]?.lines.map((line) => line.systemRole)).toEqual(["INVENTORY", "OPENING_BALANCE_EQUITY"]);
    const rice = await h.product(mine.OWNER, { name: "Rice" });
    await h.recordOpeningStock.execute(mine.MANAGER, {
      lines: [
        {
          variantId: rice.variant.id,
          quantityMinor: "2",
          unit: "PIECE",
          totalCost: { amountMinor: "100", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    expect(h.inventory.valuations.find((row) => row.variantId === rice.variant.id)?.status).toBe("VALUED");
    expect(owner.movements).toHaveLength(1);
  });

  it("opens without cost as UNVALUED with no journal", async () => {
    const { h, mine, soap, key } = await setup();
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    expect(h.inventory.valuations[0]?.status).toBe("UNVALUED");
    expect(h.ledger.entries).toHaveLength(0);
    expect(h.inventory.movementValuations[0]?.costBasis).toBe("NOT_VALUED");
    expect(h.inventory.movementValuations[0]?.journalEntryId).toBeUndefined();
  });

  it("denies STOCK_KEEPER opening stock, with or without cost", async () => {
    const { h, mine, soap, key } = await setup();
    const before = h.state();
    await expect(
      h.recordOpeningStock.execute(mine.STOCK_KEEPER, {
        lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(PermissionDeniedError);
    await expect(
      h.recordOpeningStock.execute(mine.STOCK_KEEPER, {
        lines: [
          {
            variantId: soap.variant.id,
            quantityMinor: "1",
            unit: "PIECE",
            totalCost: { amountMinor: "1", currency: "NGN" },
          },
        ],
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(PermissionDeniedError);
    expect(h.state()).toBe(before);
  });

  it("lets OWNER and MANAGER receive with cost, and STOCK_KEEPER receive without cost", async () => {
    const { h, mine, soap, key } = await setup();
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "10",
          unit: "PIECE",
          totalCost: { amountMinor: "1000", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "5",
          unit: "PIECE",
          totalCost: { amountMinor: "500", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    const oil = await h.product(mine.OWNER, { name: "Oil2" });
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: oil.variant.id,
          quantityMinor: "4",
          unit: "PIECE",
          totalCost: { amountMinor: "400", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    await h.postGoodsReceipt.execute(mine.MANAGER, {
      lines: [
        {
          variantId: oil.variant.id,
          quantityMinor: "1",
          unit: "PIECE",
          totalCost: { amountMinor: "100", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    await h.postGoodsReceipt.execute(mine.STOCK_KEEPER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    expect(h.inventory.valuations.find((row) => row.variantId === soap.variant.id)?.status).toBe("UNVALUED");
  });

  it("denies STOCK_KEEPER a cost on a goods receipt", async () => {
    const { h, mine, soap, key } = await setup();
    const before = h.state();
    await expect(
      h.postGoodsReceipt.execute(mine.STOCK_KEEPER, {
        lines: [
          {
            variantId: soap.variant.id,
            quantityMinor: "1",
            unit: "PIECE",
            totalCost: { amountMinor: "50", currency: "NGN" },
          },
        ],
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(PermissionDeniedError);
    expect(h.state()).toBe(before);
  });

  it("includes cost in the idempotency fingerprint", async () => {
    const { h, mine, soap, key } = await setup();
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "10",
          unit: "PIECE",
          totalCost: { amountMinor: "1000", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    const journalsBefore = h.ledger.entries.length;
    const idempotencyKey = key();
    const lines = [
      {
        variantId: soap.variant.id,
        quantityMinor: "3",
        unit: "PIECE",
        totalCost: { amountMinor: "90", currency: "NGN" },
      },
    ];
    const [firstLine] = lines;
    if (firstLine === undefined) throw new Error("expected a receipt line");
    await h.postGoodsReceipt.execute(mine.OWNER, { lines, idempotencyKey });
    await expect(
      h.postGoodsReceipt.execute(mine.OWNER, {
        lines: [{ ...firstLine, totalCost: { amountMinor: "91", currency: "NGN" } }],
        idempotencyKey,
      }),
    ).rejects.toThrow(IdempotencyKeyReusedError);
    const replay = await h.postGoodsReceipt.execute(mine.OWNER, { lines, idempotencyKey });
    expect(replay.replayed).toBe(true);
    expect(h.ledger.entries).toHaveLength(journalsBefore + 1);
  });

  it("rejects a cost currency that does not match the business", async () => {
    const { h, mine, soap, key } = await setup();
    await expect(
      h.postGoodsReceipt.execute(mine.OWNER, {
        lines: [
          {
            variantId: soap.variant.id,
            quantityMinor: "1",
            unit: "PIECE",
            totalCost: { amountMinor: "10", currency: "JPY" },
          },
        ],
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("accepts a non-NGN cost when that is the business currency", async () => {
    const { h, mine, soap, key } = await setup("JPY");
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "4",
          unit: "PIECE",
          totalCost: { amountMinor: "40", currency: "JPY" },
        },
      ],
      idempotencyKey: key(),
    });
    expect(h.inventory.valuations[0]?.value.currency).toBe("JPY");
    expect(h.ledger.entries[0]?.currency).toBe("JPY");
  });

  it("posts one aggregate journal for a mixed valued/unvalued receipt and omits journal id on NOT_VALUED facts", async () => {
    const { h, mine, soap, oil, key } = await setup();
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "10",
          unit: "PIECE",
          totalCost: { amountMinor: "1000", currency: "NGN" },
        },
        { variantId: oil.variant.id, quantityMinor: "4", unit: "PIECE" },
      ],
      idempotencyKey: key(),
    });
    expect(h.ledger.entries).toHaveLength(1);
    const receipt = await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "2",
          unit: "PIECE",
          totalCost: { amountMinor: "200", currency: "NGN" },
        },
        { variantId: oil.variant.id, quantityMinor: "1", unit: "PIECE" },
      ],
      idempotencyKey: key(),
    });
    expect(h.ledger.entries).toHaveLength(2);
    expect(h.ledger.entries.at(-1)?.source).toEqual({ kind: "goods_receipt", id: receipt.document.id });
    const facts = h.inventory.movementValuations.filter((row) =>
      receipt.movements.some((movement) => movement.id === row.movementId),
    );
    expect(facts).toHaveLength(2);
    const valued = facts.find((row) => row.costBasis === "SUPPLIED_COST");
    const unvalued = facts.find((row) => row.costBasis === "NOT_VALUED");
    expect(valued?.journalEntryId).toBe(h.ledger.entries.at(-1)?.id);
    expect(valued?.valueDeltaMinor).toBe(200n);
    expect(unvalued?.journalEntryId).toBeUndefined();
    expect(unvalued?.valueDeltaMinor).toBe(0n);
  });
});
