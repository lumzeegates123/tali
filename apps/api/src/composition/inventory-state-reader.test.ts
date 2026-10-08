import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Built from parts so this gate does not match itself. */
const REMOVED_NAMES = [
  ["Pre", "InventoryStateReader"].join(""),
  ["pre", "inventory-state-reader"].join("-"),
  ["NO", "INVENTORY", "YET"].join("_"),
];

function sourceRoots(): string[] {
  return ["apps", "packages"].flatMap((parent) =>
    readdirSync(join(ROOT, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, parent, entry.name, "src")))
      .map((entry) => join(ROOT, parent, entry.name, "src")),
  );
}

function files(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.(ts|tsx|mts|cts|js|mjs)$/.test(name))
    .filter((name) => !name.split(/[\\/]/).some((part) => part === "node_modules" || part === "generated"))
    .map((name) => join(directory, name));
}

function relative(file: string): string {
  return file.slice(ROOT.length).replace(/\\/g, "/");
}

describe("the production VariantInventoryStateReader (Build 2 Slice 5 gate)", () => {
  it("the temporary pre-inventory reader is gone: no file or identifier remains in any app or package source", () => {
    const roots = sourceRoots();
    expect(roots.map(relative)).toEqual(expect.arrayContaining(["apps/api/src", "packages/database/src"]));
    const offenders = roots.flatMap((root) =>
      files(root).flatMap((file) => {
        const text = readFileSync(file, "utf8");
        return REMOVED_NAMES.filter((name) => file.includes(name) || text.includes(name)).map(
          (name) => `${relative(file)}: ${name}`,
        );
      }),
    );
    expect(offenders).toEqual([]);
  });

  it("UpdateProduct is composed with the database's variantInventoryState reader, once", () => {
    const text = readFileSync(join(ROOT, "apps/api/src/composition/api-services.ts"), "utf8");
    expect(text).toMatch(/createUpdateProduct\(\{[^}]*inventory: database\.repositories\.variantInventoryState,/s);
    expect(text.match(/\binventory:/g)).toHaveLength(1);
  });

  it("no app provides its own inventory state reader", () => {
    const implementations = readdirSync(join(ROOT, "apps"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const app = join(ROOT, "apps", entry.name);
        return ["src", "test"].filter((dir) => existsSync(join(app, dir))).flatMap((dir) => files(join(app, dir)));
      })
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return /implements\s+VariantInventoryStateReader|:\s*VariantInventoryStateReader\s*=|\bstateOf\s*[:(]/.test(
          text,
        );
      })
      .map(relative);
    expect(implementations).toEqual([]);
  });

  it("the implementation lives in the database package and reads the inventory tables", () => {
    const reader = readFileSync(
      join(ROOT, "packages/database/src/repositories/variant-inventory-state-reader.ts"),
      "utf8",
    );
    for (const table of ["inventory_movements", "inventory_balances", "inventory_stock_thresholds"]) {
      expect(reader).toContain(table);
    }
    expect(reader).toContain("low_stock_threshold_minor IS NOT NULL");
    const database = readFileSync(join(ROOT, "packages/database/src/database.ts"), "utf8");
    expect(database).toContain("variantInventoryState: createVariantInventoryStateReader()");
  });
});
