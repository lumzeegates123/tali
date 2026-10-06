import {
  BARCODE_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  PACK_NAME_MAX_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
  SKU_MAX_LENGTH,
} from "@tali/domain";
import { defineAuditAction } from "../../audit/audit-action.js";
import { auditField } from "../../audit/audit-payload.js";

const UNIT_CODE_MAX_LENGTH = 16;
/** Digits of the PostgreSQL BIGINT maximum (9223372036854775807): the selling-price ceiling. */
const PRICE_MINOR_MAX_LENGTH = 19;
/** Digits of the largest pack factor (10^9). */
const PACK_FACTOR_MAX_LENGTH = 10;
const CURRENCY_CODE_LENGTH = 3;

const productName = auditField.string(PRODUCT_NAME_MAX_LENGTH);
const sku = auditField.string(SKU_MAX_LENGTH);
const barcode = auditField.string(BARCODE_MAX_LENGTH);
const unitCode = auditField.string(UNIT_CODE_MAX_LENGTH);

export const productCreated = defineAuditAction({
  name: "product.created",
  stream: "business",
  entityType: "product",
  payloadSchemaVersion: 1,
  fields: {
    variantId: auditField.id(),
    name: productName,
    sku: auditField.optional(sku),
    barcode: auditField.optional(barcode),
    stockUnit: unitCode,
    trackInventory: auditField.boolean(),
    categoryId: auditField.optional(auditField.id()),
  },
});

/**
 * From and to values of every identifying, inventory-significant field that
 * changed (name, category, SKU, barcode, stock unit, tracking). The free-text
 * description is recorded only as changed or not (ADR-008 section 16).
 */
export const productUpdated = defineAuditAction({
  name: "product.updated",
  stream: "business",
  entityType: "product",
  payloadSchemaVersion: 1,
  fields: {
    variantId: auditField.id(),
    nameChanged: auditField.boolean(),
    descriptionChanged: auditField.boolean(),
    categoryChanged: auditField.boolean(),
    skuChanged: auditField.boolean(),
    barcodeChanged: auditField.boolean(),
    stockUnitChanged: auditField.boolean(),
    trackInventoryChanged: auditField.boolean(),
    fromName: auditField.optional(productName),
    toName: auditField.optional(productName),
    fromCategoryId: auditField.optional(auditField.id()),
    toCategoryId: auditField.optional(auditField.id()),
    fromSku: auditField.optional(sku),
    toSku: auditField.optional(sku),
    fromBarcode: auditField.optional(barcode),
    toBarcode: auditField.optional(barcode),
    fromStockUnit: auditField.optional(unitCode),
    toStockUnit: auditField.optional(unitCode),
    fromTrackInventory: auditField.optional(auditField.boolean()),
    toTrackInventory: auditField.optional(auditField.boolean()),
  },
});

export const productArchived = defineAuditAction({
  name: "product.archived",
  stream: "business",
  entityType: "product",
  payloadSchemaVersion: 1,
  fields: { variantId: auditField.id() },
});

export const productReactivated = defineAuditAction({
  name: "product.reactivated",
  stream: "business",
  entityType: "product",
  payloadSchemaVersion: 1,
  fields: { variantId: auditField.id() },
});

export const productPriceSet = defineAuditAction({
  name: "product.price_set",
  stream: "business",
  entityType: "product",
  payloadSchemaVersion: 1,
  fields: {
    variantId: auditField.id(),
    fromAmountMinor: auditField.optional(
      auditField.integerString({ maxLength: PRICE_MINOR_MAX_LENGTH, allowNegative: false }),
    ),
    toAmountMinor: auditField.integerString({ maxLength: PRICE_MINOR_MAX_LENGTH, allowNegative: false }),
    currency: auditField.string(CURRENCY_CODE_LENGTH),
    priceVersion: auditField.integer(1, Number.MAX_SAFE_INTEGER),
  },
});

export const productCategoryCreated = defineAuditAction({
  name: "product_category.created",
  stream: "business",
  entityType: "product_category",
  payloadSchemaVersion: 1,
  fields: { name: auditField.string(CATEGORY_NAME_MAX_LENGTH) },
});

export const productCategoryUpdated = defineAuditAction({
  name: "product_category.updated",
  stream: "business",
  entityType: "product_category",
  payloadSchemaVersion: 1,
  fields: {
    fromName: auditField.string(CATEGORY_NAME_MAX_LENGTH),
    toName: auditField.string(CATEGORY_NAME_MAX_LENGTH),
  },
});

export const productCategoryArchived = defineAuditAction({
  name: "product_category.archived",
  stream: "business",
  entityType: "product_category",
  payloadSchemaVersion: 1,
  fields: {},
});

export const productPackAdded = defineAuditAction({
  name: "product_pack.added",
  stream: "business",
  entityType: "product_pack",
  payloadSchemaVersion: 1,
  fields: {
    variantId: auditField.id(),
    name: auditField.string(PACK_NAME_MAX_LENGTH),
    factorMinor: auditField.integerString({ maxLength: PACK_FACTOR_MAX_LENGTH, allowNegative: false }),
  },
});

export const productPackRetired = defineAuditAction({
  name: "product_pack.retired",
  stream: "business",
  entityType: "product_pack",
  payloadSchemaVersion: 1,
  fields: { variantId: auditField.id() },
});

export const catalogAuditActions = [
  productCreated,
  productUpdated,
  productArchived,
  productReactivated,
  productPriceSet,
  productCategoryCreated,
  productCategoryUpdated,
  productCategoryArchived,
  productPackAdded,
  productPackRetired,
] as const;
