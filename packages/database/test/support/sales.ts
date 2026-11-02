/**
 * Shared setup for the Build 3 Slice 5 sales integration tests: priced
 * products with opening stock written through the application use cases, and
 * sale inputs whose saleId is also the idempotency key. Test inputs only.
 */
import type { RecordSaleInput, RecordSaleLineInput } from "@tali/application";
import type { CatalogProduct } from "@tali/domain";
import { type InventoryTenant, inventoryProduct, type TenancyHarness } from "./inventory.js";

export interface SaleProduct {
  readonly product: CatalogProduct;
  readonly variantId: string;
  readonly priceVersion: number;
}

/**
 * A product with a selling price and, when tracked and given a quantity, an
 * opening balance: VALUED when `totalCost` is given, otherwise UNVALUED.
 */
export async function pricedProduct(
  harness: TenancyHarness,
  t: InventoryTenant,
  options: {
    readonly name?: string;
    readonly price?: string;
    readonly tracked?: boolean;
    readonly quantity?: string;
    readonly totalCost?: string;
  } = {},
): Promise<SaleProduct> {
  const tenancy = harness.compose();
  const product = await inventoryProduct(harness, t, {
    ...(options.name === undefined ? {} : { name: options.name }),
    trackInventory: options.tracked ?? true,
  });
  const priced = await tenancy.setSellingPrice.execute(t.context, {
    productId: product.product.id,
    expectedVersion: product.product.version,
    price: { amountMinor: options.price ?? "50000", currency: t.currency },
  });
  if (options.tracked !== false && options.quantity !== undefined) {
    await tenancy.recordOpeningStock.execute(t.context, {
      lines: [
        {
          variantId: product.variant.id,
          quantityMinor: options.quantity,
          unit: "PIECE",
          ...(options.totalCost === undefined
            ? {}
            : { totalCost: { amountMinor: options.totalCost, currency: t.currency } }),
        },
      ],
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
  }
  return { product, variantId: product.variant.id, priceVersion: priced.item.variant.priceVersion };
}

export function saleLine(
  item: SaleProduct,
  quantityMinor: string,
  extra: Partial<RecordSaleLineInput> = {},
): RecordSaleLineInput {
  return { variantId: item.variantId, quantityMinor, unit: "PIECE", expectedPriceVersion: item.priceVersion, ...extra };
}

/** A sale paid with one cash tender of `totalMinor`; the saleId is the idempotency key. */
export function saleInput(
  harness: TenancyHarness,
  lines: readonly RecordSaleLineInput[],
  totalMinor: string,
  overrides: Partial<RecordSaleInput> = {},
): RecordSaleInput {
  const saleId = overrides.saleId ?? harness.world().ids.newId("Sale");
  return {
    saleId,
    idempotencyKey: saleId,
    lines,
    tenders: [{ method: "CASH", amountMinor: totalMinor }],
    ...overrides,
  };
}

export function reversalInput(
  harness: TenancyHarness,
  saleId: string,
  options: { readonly reason?: string; readonly idempotencyKey?: string } = {},
) {
  return {
    saleId,
    reason: options.reason ?? "Customer returned the goods",
    tenderUnwoundConfirmed: true,
    idempotencyKey: options.idempotencyKey ?? harness.world().ids.newId("IdempotencyKey"),
  };
}
