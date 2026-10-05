import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  VersionConflictError,
} from "../../errors/application-error.js";
import type { CatalogHarness } from "../../testing/catalog-harness.js";
import { createCatalogHarness } from "../../testing/catalog-harness.js";

async function setup() {
  const h = createCatalogHarness({ currencies: [defineCurrency("NGN", 2), defineCurrency("KES", 2)] });
  const mine = await h.businessWithRoles("Mine", "NGN");
  const theirs = await h.businessWithRoles("Theirs", "KES");
  const key = () => h.tenancy.ids.newId("IdempotencyKey");
  return { h, mine, theirs, key };
}

function state(h: CatalogHarness) {
  return JSON.stringify({
    categories: h.catalog.categories,
    audit: h.tenancy.auditWriter.businessRecords.length,
    keys: h.tenancy.businessIdempotencyStore.records.length,
  });
}

function categoryAudit(h: CatalogHarness) {
  return h.tenancy.auditWriter.businessRecords.filter((record) => record.action.startsWith("product_category."));
}

describe("CreateCategory", () => {
  it("creates an ACTIVE category and audits its name", async () => {
    const { h, mine, key } = await setup();
    const { category, replayed } = await h.createCategory.execute(mine.STOCK_KEEPER, {
      name: "  Drinks ",
      idempotencyKey: key(),
    });
    expect(replayed).toBe(false);
    expect(category).toMatchObject({ name: "Drinks", status: "ACTIVE", version: 1, businessId: mine.OWNER.businessId });
    expect(categoryAudit(h)).toMatchObject([
      {
        action: "product_category.created",
        entityType: "product_category",
        entityId: category.id,
        payload: { name: "Drinks" },
      },
    ]);
  });

  it("replays the same key and command; rejects the key with a different command", async () => {
    const { h, mine, key } = await setup();
    const idempotencyKey = key();
    const first = await h.createCategory.execute(mine.OWNER, { name: "Drinks", idempotencyKey });
    const before = state(h);
    const replay = await h.createCategory.execute(mine.OWNER, { name: "Drinks", idempotencyKey });
    expect(replay).toEqual({ category: first.category, replayed: true });
    expect(state(h)).toBe(before);
    await expect(h.createCategory.execute(mine.OWNER, { name: "Snacks", idempotencyKey })).rejects.toThrow(
      IdempotencyKeyReusedError,
    );
    await expect(h.createCategory.execute(mine.OWNER, { name: "Snacks", idempotencyKey: undefined })).rejects.toThrow(
      IdempotencyKeyRequiredError,
    );
  });

  it("rejects a case-insensitive duplicate among ACTIVE categories; archived names are reusable", async () => {
    const { h, mine, key } = await setup();
    const { category } = await h.createCategory.execute(mine.OWNER, { name: "Drinks", idempotencyKey: key() });
    await expect(h.createCategory.execute(mine.OWNER, { name: "DRINKS", idempotencyKey: key() })).rejects.toThrow(
      ConflictError,
    );
    await h.archiveCategory.execute(mine.OWNER, { categoryId: category.id, expectedVersion: 1 });
    const again = await h.createCategory.execute(mine.OWNER, { name: "drinks", idempotencyKey: key() });
    expect(again.category.id).not.toBe(category.id);
  });

  it("does not collide with another business's category names", async () => {
    const { h, mine, theirs, key } = await setup();
    await h.createCategory.execute(theirs.OWNER, { name: "Drinks", idempotencyKey: key() });
    expect((await h.createCategory.execute(mine.OWNER, { name: "Drinks", idempotencyKey: key() })).replayed).toBe(
      false,
    );
  });

  it.each(["CASHIER", "ACCOUNTANT"] as const)("denies %s without writing", async (role) => {
    const { h, mine, key } = await setup();
    const before = state(h);
    await expect(h.createCategory.execute(mine[role], { name: "Drinks", idempotencyKey: key() })).rejects.toThrow(
      PermissionDeniedError,
    );
    expect(state(h)).toBe(before);
  });

  it.each(["  ", "x".repeat(61)])("rejects the name %j without writing", async (name) => {
    const { h, mine, key } = await setup();
    const before = state(h);
    await expect(h.createCategory.execute(mine.OWNER, { name, idempotencyKey: key() })).rejects.toThrow(
      ValidationError,
    );
    expect(state(h)).toBe(before);
  });
});

describe("UpdateCategory and ArchiveCategory", () => {
  async function withCategory() {
    const context = await setup();
    const { category } = await context.h.createCategory.execute(context.mine.OWNER, {
      name: "Drinks",
      idempotencyKey: context.key(),
    });
    return { ...context, category };
  }

  it("renames with from/to audit; the same name is a no-op without audit", async () => {
    const { h, mine, category } = await withCategory();
    const renamed = await h.updateCategory.execute(mine.MANAGER, {
      categoryId: category.id,
      expectedVersion: 1,
      name: "Soft drinks",
    });
    expect(renamed.category).toMatchObject({ name: "Soft drinks", version: 2 });
    expect(categoryAudit(h).at(-1)).toMatchObject({
      action: "product_category.updated",
      payload: { fromName: "Drinks", toName: "Soft drinks" },
    });
    const before = state(h);
    const same = await h.updateCategory.execute(mine.OWNER, {
      categoryId: category.id,
      expectedVersion: 2,
      name: "Soft drinks",
    });
    expect(same.changed).toBe(false);
    expect(same.category.version).toBe(2);
    expect(state(h)).toBe(before);
    await expect(
      h.updateCategory.execute(mine.OWNER, { categoryId: category.id, expectedVersion: 1, name: "Soft drinks" }),
    ).rejects.toThrow(VersionConflictError);
    expect(state(h)).toBe(before);
  });

  it("rejects a stale version and a name held by another active category", async () => {
    const { h, mine, key, category } = await withCategory();
    await h.createCategory.execute(mine.OWNER, { name: "Snacks", idempotencyKey: key() });
    await expect(
      h.updateCategory.execute(mine.OWNER, { categoryId: category.id, expectedVersion: 1, name: "snacks" }),
    ).rejects.toThrow(ConflictError);
    await h.updateCategory.execute(mine.OWNER, { categoryId: category.id, expectedVersion: 1, name: "Juice" });
    const before = state(h);
    await expect(
      h.updateCategory.execute(mine.OWNER, { categoryId: category.id, expectedVersion: 1, name: "Water" }),
    ).rejects.toThrow(VersionConflictError);
    expect(state(h)).toBe(before);
  });

  it("archives once with audit; a repeat is a no-op; a stale version conflicts", async () => {
    const { h, mine, category } = await withCategory();
    await h.updateCategory.execute(mine.OWNER, { categoryId: category.id, expectedVersion: 1, name: "Juice" });
    await expect(
      h.archiveCategory.execute(mine.OWNER, { categoryId: category.id, expectedVersion: 1 }),
    ).rejects.toThrow(VersionConflictError);
    const archived = await h.archiveCategory.execute(mine.STOCK_KEEPER, {
      categoryId: category.id,
      expectedVersion: 2,
    });
    expect(archived.category.status).toBe("ARCHIVED");
    expect(categoryAudit(h).at(-1)).toMatchObject({ action: "product_category.archived", payload: {} });
    const before = state(h);
    const again = await h.archiveCategory.execute(mine.OWNER, { categoryId: category.id, expectedVersion: 3 });
    expect(again.changed).toBe(false);
    expect(again.category.version).toBe(3);
    expect(state(h)).toBe(before);
    await expect(
      h.archiveCategory.execute(mine.OWNER, { categoryId: category.id, expectedVersion: 2 }),
    ).rejects.toThrow(VersionConflictError);
    expect(state(h)).toBe(before);
    expect(h.catalog.categories).toHaveLength(1);
  });

  it("denies roles without product:manage and hides other businesses' categories", async () => {
    const { h, mine, theirs, category } = await withCategory();
    const before = state(h);
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      await expect(
        h.updateCategory.execute(mine[role], { categoryId: category.id, expectedVersion: 1, name: "X" }),
      ).rejects.toThrow(PermissionDeniedError);
      await expect(
        h.archiveCategory.execute(mine[role], { categoryId: category.id, expectedVersion: 1 }),
      ).rejects.toThrow(PermissionDeniedError);
    }
    await expect(
      h.updateCategory.execute(theirs.OWNER, { categoryId: category.id, expectedVersion: 1, name: "X" }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      h.archiveCategory.execute(theirs.OWNER, { categoryId: category.id, expectedVersion: 1 }),
    ).rejects.toThrow(NotFoundError);
    await expect(h.archiveCategory.execute(mine.OWNER, { categoryId: "x", expectedVersion: 1 })).rejects.toThrow(
      NotFoundError,
    );
    expect(state(h)).toBe(before);
  });

  it("rejects malformed input without writing", async () => {
    const { h, mine, category } = await withCategory();
    const before = state(h);
    await expect(
      h.updateCategory.execute(mine.OWNER, { categoryId: category.id, expectedVersion: 1, name: " " }),
    ).rejects.toThrow(ValidationError);
    await expect(
      h.updateCategory.execute(mine.OWNER, { categoryId: category.id, expectedVersion: -1, name: "Ok" }),
    ).rejects.toThrow(ValidationError);
    expect(state(h)).toBe(before);
  });
});
