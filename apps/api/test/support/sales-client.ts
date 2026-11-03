import { randomUUID } from "node:crypto";
import { parseBusinessId, parseSaleId } from "@tali/domain";
import { uuidV7IdGenerator } from "@tali/integrations/platform";
import { ProductResponseSchema } from "@tali/shared";
import type { ApiHarness } from "./api-harness.js";
import { type InventoryWorld, inventoryClient, type Role, type StockItem } from "./inventory-client.js";
import type { RegisteredActor } from "./tenancy-client.js";

/** Keys that must never appear anywhere in a sales or ledger response. */
export const FORBIDDEN_SALES_KEYS = [
  "businessId",
  "business_id",
  "actorMembershipId",
  "recordedByMembershipId",
  "reversedByMembershipId",
  "deviceId",
  "correlationId",
  "sourceChannel",
  "idempotencyKey",
  "fingerprint",
  "journalEntryId",
  "reversalJournalEntryId",
  "movementId",
  "margin",
  "marginMinor",
  "grossProfit",
] as const;

const STRING_AMOUNT_KEYS = new Set([
  "amountMinor",
  "quantityMinor",
  "currentPriceMinor",
  "availableQuantityMinor",
  "serverTotalMinor",
]);

/** Paths of money or quantity fields that are not strings (a JSON number or anything else). */
export function nonStringAmounts(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => nonStringAmounts(item, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(STRING_AMOUNT_KEYS.has(key) && typeof child !== "string" ? [`${path}.${key}`] : []),
    ...nonStringAmounts(child, `${path}.${key}`),
  ]);
}

export interface SellableItem extends StockItem {
  readonly priceMinor: string;
  readonly priceVersion: number;
}

export interface PricedItemOptions {
  readonly price?: string;
  readonly tracked?: boolean;
  /** Whole pieces received at the default location. */
  readonly stock?: string;
  /** Initial valuation of the received stock; without it the stock is unvalued. */
  readonly stockCost?: string;
  readonly businessId?: string;
  readonly owner?: RegisteredActor;
  readonly currency?: string;
}

/** HTTP helpers for sales on top of the inventory client. */
export function salesClient(api: ApiHarness, world: () => InventoryWorld) {
  const inventory = inventoryClient(api, world);
  const money = (amountMinor: string, currency = "KES") => ({ amountMinor, currency });

  async function pricedItem(options: PricedItemOptions = {}): Promise<SellableItem> {
    const businessId = options.businessId ?? world().a;
    const owner = options.owner ?? world().actors.OWNER;
    const currency = options.currency ?? "KES";
    const price = options.price ?? "50000";
    const created = await inventory.product({ trackInventory: options.tracked ?? true }, owner, businessId);
    const priced = ProductResponseSchema.parse(
      (
        await inventory
          .put(
            `products/${created.productId}/price`,
            { expectedVersion: created.version, price: money(price, currency) },
            owner,
            businessId,
          )
          .expect(200)
      ).body,
    );
    if (options.stock !== undefined) {
      await inventory
        .keyed(
          "inventory/goods-receipts",
          { lines: [{ variantId: created.variantId, quantityMinor: options.stock, unit: "PIECE" }] },
          owner,
          randomUUID(),
          businessId,
        )
        .expect(201);
    }
    if (options.stockCost !== undefined) {
      await inventory
        .keyed(
          "inventory/valuations",
          {
            variantId: created.variantId,
            expectedBalanceVersion: 1,
            newTotalValue: money(options.stockCost, currency),
            reason: "Opening value",
          },
          owner,
          randomUUID(),
          businessId,
        )
        .expect(201);
    }
    return { ...created, version: priced.version, priceMinor: price, priceVersion: priced.priceVersion };
  }

  function saleBody(
    lines: readonly (readonly [SellableItem, string, Record<string, unknown>?])[],
    tenders?: readonly Record<string, unknown>[],
    currency = "KES",
  ) {
    const total = lines.reduce((sum, [item, quantity]) => sum + BigInt(item.priceMinor) * BigInt(quantity), 0n);
    return {
      saleId: uuidV7IdGenerator.newId("sale"),
      lines: lines.map(([item, quantityMinor, extra]) => ({
        variantId: item.variantId,
        quantity: { quantityMinor, unit: "PIECE" },
        expectedPriceVersion: item.priceVersion,
        ...extra,
      })),
      tenders: tenders ?? [{ method: "CASH", amount: money(total.toString(), currency) }],
    };
  }

  /** Records a sale; the key defaults to the sale ID, `null` sends none. */
  function sell(
    body: { readonly saleId: string } & Record<string, unknown>,
    actor: RegisteredActor = world().actors.OWNER,
    key: string | null = body.saleId,
    businessId = world().a,
  ) {
    return inventory.keyed("sales", body, actor, key, businessId);
  }

  function reverse(
    saleId: string,
    body: Record<string, unknown> = { reason: "Customer returned the goods", tenderUnwoundConfirmed: true },
    actor: RegisteredActor = world().actors.OWNER,
    key: string | null = randomUUID(),
    businessId = world().a,
  ) {
    return inventory.keyed(`sales/${saleId}/reversal`, body, actor, key, businessId);
  }

  /** The journal entries of a sale, read through the runtime's repositories (never exposed over HTTP). */
  async function journalsOf(saleId: string, businessId = world().a) {
    const { unitOfWork, repositories } = api.runtime.database;
    const sale = await unitOfWork.run((scope) =>
      repositories.sales.findById(scope, parseBusinessId(businessId), parseSaleId(saleId)),
    );
    if (sale?.journalEntryId === undefined) throw new Error("the sale has no original journal entry");
    return { original: sale.journalEntryId as string, reversal: sale.reversalJournalEntryId as string | undefined };
  }

  /** Number of posted journal lines of a business. */
  async function journalLineCount(businessId = world().a): Promise<number> {
    const { unitOfWork, repositories } = api.runtime.database;
    return (
      await unitOfWork.run((scope) => repositories.journals.listLinesForBusiness(scope, parseBusinessId(businessId)))
    ).length;
  }

  const as = (role: Role) => world().actors[role];

  return { ...inventory, as, money, pricedItem, saleBody, sell, reverse, journalsOf, journalLineCount };
}
