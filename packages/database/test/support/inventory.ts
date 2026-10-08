/**
 * Shared setup for the Build 2 Slice 5 inventory integration tests: tenants
 * bound to their default location, products and packs written through the
 * catalog repositories, an extra ACTIVE location inserted as the owner (the
 * MVP has no use case that creates one), and raw-row helpers for
 * constraint tests. Test inputs only.
 */
import type { LocationBoundContext } from "@tali/application";
import type {
  BusinessId,
  CatalogProduct,
  CurrencyCode,
  LocationId,
  MembershipId,
  ProductPack,
  ProductVariant,
} from "@tali/domain";
import {
  createPack,
  createProduct,
  parseLocationId,
  parsePackName,
  parseProductName,
  parseUnitCode,
} from "@tali/domain";
import type pg from "pg";
import type { RegisteredUser, useTenancyHarness } from "./tenancy.js";

export type TenancyHarness = ReturnType<typeof useTenancyHarness>;

export interface InventoryTenant {
  readonly user: RegisteredUser;
  readonly businessId: BusinessId;
  readonly membershipId: MembershipId;
  readonly locationId: LocationId;
  readonly currency: CurrencyCode;
  /** The owner's context, bound to the default location. */
  readonly context: LocationBoundContext;
}

export async function inventoryTenant(
  harness: TenancyHarness,
  subject: string,
  currencyCode = "NGN",
): Promise<InventoryTenant> {
  const tenancy = harness.compose();
  const user = await tenancy.registeredUser(subject);
  const { result } = await tenancy.create(user, { currencyCode });
  const context = await tenancy.boundContextFor(user, result.business.id);
  return {
    user,
    businessId: result.business.id,
    membershipId: result.membership.id,
    locationId: context.locationId,
    currency: result.business.currencyCode,
    context,
  };
}

/** A product with its default variant, written through the catalog repository. */
export async function inventoryProduct(
  harness: TenancyHarness,
  t: InventoryTenant,
  options: { readonly name?: string; readonly stockUnit?: string; readonly trackInventory?: boolean } = {},
): Promise<CatalogProduct> {
  const world = harness.world();
  const { item } = createProduct({
    id: world.ids.newId("Product"),
    variantId: world.ids.newId("ProductVariant"),
    businessId: t.businessId,
    name: parseProductName(options.name ?? "Peak Milk 400g"),
    stockUnit: parseUnitCode(options.stockUnit ?? "PIECE"),
    trackInventory: options.trackInventory ?? true,
    createdByMembershipId: t.membershipId,
    now: world.clock.now(),
  });
  await harness.unitOfWork.run((scope) => harness.repositories.products.insert(scope, item));
  return item;
}

export async function inventoryPack(
  harness: TenancyHarness,
  variant: ProductVariant,
  name = "Carton",
  factorMinor = 24n,
): Promise<ProductPack> {
  const world = harness.world();
  const pack = createPack({
    id: world.ids.newId("ProductPack"),
    variant,
    name: parsePackName(name),
    factorMinor,
    now: world.clock.now(),
  });
  await harness.unitOfWork.run((scope) => harness.repositories.productPacks.insert(scope, pack));
  return pack;
}

/** A second ACTIVE, non-default location, inserted as the owner. */
export async function secondLocation(
  harness: TenancyHarness,
  businessId: BusinessId,
  name = "Back store",
): Promise<LocationId> {
  const id = parseLocationId(harness.world().ids.newId("Location"));
  await harness.owner.query(
    `INSERT INTO business_locations (business_id, id, name, is_default, status, created_at, updated_at)
     VALUES ($1, $2, $3, false, 'ACTIVE', now(), now())`,
    [businessId, id, name],
  );
  return id;
}

/** Inserts one row from test-constant column names with bound values. */
export async function insertRow(
  client: pg.Pool | pg.PoolClient,
  table: string,
  row: Readonly<Record<string, unknown>>,
): Promise<void> {
  const columns = Object.keys(row);
  await client.query(
    `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(", ")})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
    Object.values(row),
  );
}

/** The SQLSTATE and constraint of a rejected statement. */
export async function violation(promise: Promise<unknown>): Promise<{ code: string; constraint: string | undefined }> {
  try {
    await promise;
  } catch (error) {
    const { code, constraint } = error as { code?: unknown; constraint?: unknown };
    return { code: String(code), constraint: typeof constraint === "string" ? constraint : undefined };
  }
  throw new Error("expected the statement to fail");
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}
