import { DomainError } from "../../errors.js";
import type { UnitCode } from "../../kernel/index.js";
import { Quantity } from "../../kernel/index.js";
import { normalizeBoundedName } from "../../text.js";
import type { BusinessId } from "../business/index.js";
import { validInstant } from "./common.js";
import type { ProductPackId, ProductVariantId } from "./ids.js";
import type { ProductVariant } from "./product.js";

export const PACK_STATUSES = ["ACTIVE", "RETIRED"] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];

declare const packNameBrand: unique symbol;

/** 1 to 40 characters after trimming and NFC normalization, e.g. "Carton of 24". */
export type PackName = string & { readonly [packNameBrand]: true };

export const PACK_NAME_MAX_LENGTH = 40;
export const MIN_PACK_FACTOR = 2n;
export const MAX_PACK_FACTOR = 1_000_000_000n;

export function parsePackName(value: string): PackName {
  return normalizeBoundedName(value, "name", PACK_NAME_MAX_LENGTH) as PackName;
}

/** An exact integer number of stock-unit minor quantities per pack, 2 to 10^9 (ADR-008 section 3.4). */
export function parsePackFactor(value: bigint): bigint {
  if (typeof value !== "bigint" || value < MIN_PACK_FACTOR || value > MAX_PACK_FACTOR) {
    throw new DomainError(
      "INVALID_VALUE",
      `factorMinor must be an integer from ${MIN_PACK_FACTOR} to ${MAX_PACK_FACTOR}`,
      "factorMinor",
    );
  }
  return value;
}

/**
 * A data-entry conversion: one pack is `factorMinor` minor quantities of its
 * variant's stock unit. Name and factor are immutable; a wrong pack is retired
 * and a new one added. A pack has no barcode and no price, and nothing is
 * sold by the pack in Build 2.
 */
export interface ProductPack {
  readonly id: ProductPackId;
  readonly businessId: BusinessId;
  readonly variantId: ProductVariantId;
  readonly name: PackName;
  readonly factorMinor: bigint;
  readonly status: PackStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type PackTransition =
  | { readonly outcome: "unchanged"; readonly pack: ProductPack }
  | { readonly outcome: "changed"; readonly pack: ProductPack; readonly previous: ProductPack };

export function createPack(props: {
  readonly id: ProductPackId;
  readonly variant: ProductVariant;
  readonly name: PackName;
  readonly factorMinor: bigint;
  readonly now: Date;
}): ProductPack {
  const now = validInstant(props.now, "now");
  return Object.freeze({
    id: props.id,
    businessId: props.variant.businessId,
    variantId: props.variant.id,
    name: props.name,
    factorMinor: parsePackFactor(props.factorMinor),
    status: "ACTIVE",
    createdAt: now,
    updatedAt: new Date(now.getTime()),
  });
}

export function restorePack(props: {
  readonly id: ProductPackId;
  readonly businessId: BusinessId;
  readonly variantId: ProductVariantId;
  readonly name: string;
  readonly factorMinor: bigint;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): ProductPack {
  if (!(PACK_STATUSES as readonly string[]).includes(props.status)) {
    throw new DomainError("INVALID_VALUE", "unknown pack status", "status");
  }
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    variantId: props.variantId,
    name: parsePackName(props.name),
    factorMinor: parsePackFactor(props.factorMinor),
    status: props.status as PackStatus,
    createdAt: validInstant(props.createdAt, "createdAt"),
    updatedAt: validInstant(props.updatedAt, "updatedAt"),
  });
}

/** Retiring a RETIRED pack is a no-op. Retirement is one-way; packs carry no version (ADR-008 section 3.4). */
export function retirePack(props: { readonly pack: ProductPack; readonly now: Date }): PackTransition {
  const { pack } = props;
  if (pack.status === "RETIRED") return { outcome: "unchanged", pack };
  return {
    outcome: "changed",
    previous: pack,
    pack: Object.freeze({ ...pack, status: "RETIRED", updatedAt: validInstant(props.now, "now") }),
  };
}

/**
 * Converts a whole number of packs entered by a person into the variant's
 * stock-unit quantity (packCount x factorMinor, exact). The result, not the
 * pack, is what an inventory movement will record; the pack is evidence only.
 */
export function packEntryQuantity(props: {
  readonly pack: ProductPack;
  readonly stockUnit: UnitCode;
  readonly packCount: bigint;
}): Quantity {
  if (props.pack.status !== "ACTIVE") {
    throw new DomainError("INVALID_TRANSITION", "a retired pack cannot be used for new entries", "packId");
  }
  if (typeof props.packCount !== "bigint" || props.packCount < 1n) {
    throw new DomainError("INVALID_VALUE", "packCount must be a positive whole number", "packCount");
  }
  return Quantity.ofMinor(props.pack.factorMinor, props.stockUnit).multiply(props.packCount);
}
