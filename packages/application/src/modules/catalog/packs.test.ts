import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  IdempotencyKeyReusedError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "../../errors/application-error.js";
import type { CatalogHarness } from "../../testing/catalog-harness.js";
import { createCatalogHarness } from "../../testing/catalog-harness.js";

async function setup() {
  const h = createCatalogHarness({ currencies: [defineCurrency("NGN", 2), defineCurrency("KES", 2)] });
  const mine = await h.businessWithRoles("Mine", "NGN");
  const theirs = await h.businessWithRoles("Theirs", "KES");
  const key = () => h.tenancy.ids.newId("IdempotencyKey");
  const { item } = await h.createProduct.execute(mine.OWNER, {
    name: "Rice",
    stockUnit: "KG",
    trackInventory: true,
    idempotencyKey: key(),
  });
  return { h, mine, theirs, key, item };
}

function state(h: CatalogHarness) {
  return JSON.stringify({
    packs: h.catalog.packs.map((pack) => [pack.id, pack.status, pack.factorMinor.toString()]),
    audit: h.tenancy.auditWriter.businessRecords.length,
    keys: h.tenancy.businessIdempotencyStore.records.length,
  });
}

function packAudit(h: CatalogHarness) {
  return h.tenancy.auditWriter.businessRecords.filter((record) => record.action.startsWith("product_pack."));
}

describe("AddPack", () => {
  it("adds a pack to the default variant in minor stock units and audits the factor as an integer string", async () => {
    const { h, mine, key, item } = await setup();
    const { pack, replayed } = await h.addPack.execute(mine.STOCK_KEEPER, {
      productId: item.product.id,
      name: "Bag of 50 kg",
      factorMinor: "50000",
      idempotencyKey: key(),
    });
    expect(replayed).toBe(false);
    expect(pack).toMatchObject({ variantId: item.variant.id, factorMinor: 50_000n, status: "ACTIVE" });
    expect(packAudit(h)).toMatchObject([
      {
        action: "product_pack.added",
        entityType: "product_pack",
        entityId: pack.id,
        payload: { variantId: item.variant.id, name: "Bag of 50 kg", factorMinor: "50000" },
      },
    ]);
  });

  it("replays the same key and command; rejects the key with a different factor", async () => {
    const { h, mine, key, item } = await setup();
    const idempotencyKey = key();
    const command = { productId: item.product.id, name: "Bag", factorMinor: "50000", idempotencyKey };
    const first = await h.addPack.execute(mine.OWNER, command);
    const before = state(h);
    expect(await h.addPack.execute(mine.OWNER, command)).toEqual({ pack: first.pack, replayed: true });
    expect(state(h)).toBe(before);
    await expect(h.addPack.execute(mine.OWNER, { ...command, factorMinor: "25000" })).rejects.toThrow(
      IdempotencyKeyReusedError,
    );
  });

  it("rejects a duplicate active name on the variant; a retired name can be reused", async () => {
    const { h, mine, key, item } = await setup();
    const { pack } = await h.addPack.execute(mine.OWNER, {
      productId: item.product.id,
      name: "Bag",
      factorMinor: "50000",
      idempotencyKey: key(),
    });
    await expect(
      h.addPack.execute(mine.OWNER, {
        productId: item.product.id,
        name: "Bag",
        factorMinor: "25000",
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(ConflictError);
    await h.retirePack.execute(mine.OWNER, { packId: pack.id });
    const replacement = await h.addPack.execute(mine.OWNER, {
      productId: item.product.id,
      name: "Bag",
      factorMinor: "25000",
      idempotencyKey: key(),
    });
    expect(replacement.pack.factorMinor).toBe(25_000n);
  });

  it.each([
    ["factor 1", "1"],
    ["factor 0", "0"],
    ["a negative factor", "-24"],
    ["a decimal factor", "2.5"],
    ["a leading zero", "024"],
    ["above 10^9", "1000000001"],
    ["a number", 24 as unknown as string],
  ])("rejects %s without writing", async (_label, factorMinor) => {
    const { h, mine, key, item } = await setup();
    const before = state(h);
    await expect(
      h.addPack.execute(mine.OWNER, { productId: item.product.id, name: "Crate", factorMinor, idempotencyKey: key() }),
    ).rejects.toThrow(ValidationError);
    expect(state(h)).toBe(before);
  });

  it("accepts the factor bounds 2 and 10^9", async () => {
    const { h, mine, key, item } = await setup();
    for (const [name, factorMinor] of [
      ["Pair", "2"],
      ["Tanker", "1000000000"],
    ] as const) {
      const { pack } = await h.addPack.execute(mine.OWNER, {
        productId: item.product.id,
        name,
        factorMinor,
        idempotencyKey: key(),
      });
      expect(pack.factorMinor).toBe(BigInt(factorMinor));
    }
  });

  it("denies roles without product:manage and hides other businesses' products", async () => {
    const { h, mine, theirs, key, item } = await setup();
    const before = state(h);
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      await expect(
        h.addPack.execute(mine[role], {
          productId: item.product.id,
          name: "Bag",
          factorMinor: "2",
          idempotencyKey: key(),
        }),
      ).rejects.toThrow(PermissionDeniedError);
    }
    await expect(
      h.addPack.execute(theirs.OWNER, {
        productId: item.product.id,
        name: "Bag",
        factorMinor: "2",
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(NotFoundError);
    expect(state(h)).toBe(before);
  });
});

describe("RetirePack", () => {
  it("retires one way with audit; a repeat is a no-op without audit", async () => {
    const { h, mine, key, item } = await setup();
    const { pack } = await h.addPack.execute(mine.OWNER, {
      productId: item.product.id,
      name: "Bag",
      factorMinor: "50000",
      idempotencyKey: key(),
    });
    const retired = await h.retirePack.execute(mine.STOCK_KEEPER, { packId: pack.id });
    expect(retired).toMatchObject({ changed: true, pack: { status: "RETIRED", factorMinor: 50_000n, name: "Bag" } });
    expect(packAudit(h).at(-1)).toMatchObject({
      action: "product_pack.retired",
      payload: { variantId: item.variant.id },
    });
    const before = state(h);
    expect((await h.retirePack.execute(mine.OWNER, { packId: pack.id })).changed).toBe(false);
    expect(state(h)).toBe(before);
    expect(h.catalog.packs).toHaveLength(1);
  });

  it("denies roles without product:manage and hides other businesses' packs", async () => {
    const { h, mine, theirs, key, item } = await setup();
    const { pack } = await h.addPack.execute(mine.OWNER, {
      productId: item.product.id,
      name: "Bag",
      factorMinor: "50000",
      idempotencyKey: key(),
    });
    const before = state(h);
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      await expect(h.retirePack.execute(mine[role], { packId: pack.id })).rejects.toThrow(PermissionDeniedError);
    }
    await expect(h.retirePack.execute(theirs.OWNER, { packId: pack.id })).rejects.toThrow(NotFoundError);
    await expect(h.retirePack.execute(mine.OWNER, { packId: "nope" })).rejects.toThrow(NotFoundError);
    expect(state(h)).toBe(before);
  });
});
