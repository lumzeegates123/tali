import { describe, expect, it } from "vitest";
import { inventoryAffordances, type InventoryPermission } from "../src/inventory/affordances";
import { salesAffordances } from "../src/sales/affordances";

/**
 * Role affordances are UX only: they decide which screens and actions are
 * offered. The API is authoritative and checks every request; these tests
 * pin the client copy of the role mapping, not any authorization.
 */
describe("sales affordances (UX only; the API is authoritative)", () => {
  it.each([
    ["OWNER", { salesVisible: true, readAll: true, create: true, discount: true, reverse: true, ledger: true }],
    ["MANAGER", { salesVisible: true, readAll: true, create: true, discount: true, reverse: true, ledger: false }],
    ["CASHIER", { salesVisible: true, readAll: false, create: true, discount: false, reverse: false, ledger: false }],
    ["ACCOUNTANT", { salesVisible: true, readAll: true, create: false, discount: false, reverse: false, ledger: true }],
    [
      "STOCK_KEEPER",
      { salesVisible: false, readAll: false, create: false, discount: false, reverse: false, ledger: false },
    ],
  ])("%s", (role, expected) => {
    expect(salesAffordances(role)).toEqual(expected);
  });

  it.each([undefined, "", "SUPERUSER", "constructor", "__proto__", "owner"])("offers nothing to role %s", (role) => {
    expect(salesAffordances(role)).toEqual({
      salesVisible: false,
      readAll: false,
      create: false,
      discount: false,
      reverse: false,
      ledger: false,
    });
  });

  it("returns a frozen copy that cannot grant more", () => {
    const owner = salesAffordances("OWNER");
    expect(Object.isFrozen(owner)).toBe(true);
    expect(salesAffordances("CASHIER").reverse).toBe(false);
  });
});

describe("inventory value and cost-read affordances (UX only; the API is authoritative)", () => {
  const can = (role: string, permission: InventoryPermission) => inventoryAffordances(role).can(permission);

  it.each([
    ["OWNER", true, true],
    ["MANAGER", true, true],
    ["ACCOUNTANT", false, true],
    ["CASHIER", false, false],
    ["STOCK_KEEPER", false, false],
  ])("%s: inventory:value %s, inventory:cost-read %s", (role, value, costRead) => {
    expect(can(role, "inventory:value")).toBe(value);
    expect(can(role, "inventory:cost-read")).toBe(costRead);
  });

  it("an unknown role offers neither", () => {
    expect(inventoryAffordances("SUPERUSER").can("inventory:value")).toBe(false);
    expect(inventoryAffordances(undefined).can("inventory:cost-read")).toBe(false);
  });
});
