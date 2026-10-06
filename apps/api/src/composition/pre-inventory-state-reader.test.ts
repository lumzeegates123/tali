import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TransactionScope, VariantInventoryStateReader } from "@tali/application";
import { parseBusinessId, parseProductVariantId } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { PreInventoryStateReader } from "./pre-inventory-state-reader.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INVENTORY_NAME = /inventor|movement|balance|stock.?take|stock.?count|goods.?receipt|purchase.?receipt/i;

function files(directory: string, suffix: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(suffix) && !name.split(/[\\/]/).includes("node_modules"))
    .map((name) => join(directory, name));
}

/** A transaction scope that fails on any use: the reader must not touch it. */
const untouchableScope = new Proxy(
  {},
  {
    get() {
      throw new Error("PreInventoryStateReader must perform no I/O");
    },
  },
) as TransactionScope;

describe("PreInventoryStateReader (temporary; Slice 5 must delete or replace it)", () => {
  it("reports exactly no movements and a zero balance, without I/O, for any variant", async () => {
    const reader: VariantInventoryStateReader = new PreInventoryStateReader();
    const businessId = parseBusinessId("0190a000-0000-7000-8000-000000000001");
    for (const variant of ["0190a000-0000-7000-8000-000000000002", "0190a000-0000-7000-8000-000000000003"]) {
      const state = await reader.stateOf(untouchableScope, businessId, parseProductVariantId(variant));
      expect(state).toStrictEqual({ hasMovements: false, hasNonZeroBalance: false });
      expect(Object.isFrozen(state)).toBe(true);
    }
  });

  it("is only truthful while no inventory persistence exists: no inventory model or table", () => {
    const schema = files(join(ROOT, "packages/database/prisma/schema"), ".prisma").map((f) => readFileSync(f, "utf8"));
    const models = schema.flatMap((text) => [...text.matchAll(/^model\s+(\w+)/gm)].map((match) => match[1] ?? ""));
    const maps = schema.flatMap((text) => [...text.matchAll(/@@map\("([^"]+)"\)/g)].map((match) => match[1] ?? ""));
    const migrations = files(join(ROOT, "packages/database/prisma/migrations"), ".sql").map((f) =>
      readFileSync(f, "utf8"),
    );
    const tables = migrations.flatMap((sql) =>
      [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)].map((match) => match[1] ?? ""),
    );
    expect(models.length).toBeGreaterThan(0);
    expect(tables.length).toBeGreaterThan(0);
    expect([...models, ...maps, ...tables].filter((name) => INVENTORY_NAME.test(name))).toEqual([]);
  });

  it("is only truthful while no inventory use case exists: no inventory module anywhere", () => {
    for (const modules of ["packages/domain/src/modules", "packages/application/src/modules"]) {
      const names = readdirSync(join(ROOT, modules), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      expect(names.filter((name) => INVENTORY_NAME.test(name))).toEqual([]);
    }
    for (const app of ["apps/api/src", "apps/worker/src"]) {
      const names = readdirSync(join(ROOT, app), { recursive: true, encoding: "utf8" }).filter(
        (name) => !/pre-inventory-state-reader(\.test)?\.ts$/.test(name),
      );
      expect(names.filter((name) => INVENTORY_NAME.test(name))).toEqual([]);
    }
  });

  it("is composed once, into UpdateProduct only", () => {
    const uses = files(join(ROOT, "apps/api/src"), ".ts")
      .filter((file) => !/pre-inventory-state-reader(\.test)?\.ts$/.test(file))
      .flatMap((file) => {
        const text = readFileSync(file, "utf8");
        return text.includes("PreInventoryStateReader") ? [{ file, text }] : [];
      });
    expect(uses.map(({ file }) => file.replace(/\\/g, "/").replace(/^.*\/apps\/api\//, ""))).toEqual([
      "src/composition/api-services.ts",
    ]);
    const text = uses[0]?.text ?? "";
    expect(text.match(/new PreInventoryStateReader\(\)/g)).toHaveLength(1);
    expect(text).toMatch(/createUpdateProduct\(\{[^}]*inventory: new PreInventoryStateReader\(\)/s);
  });
});
