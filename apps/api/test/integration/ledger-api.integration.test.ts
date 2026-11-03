import { readLedgerConsistency, readSalesConsistency, readTenancySnapshot } from "@tali/database/testing";
import {
  type AccountBalanceResponse,
  AccountBalancesResponseSchema,
  type JournalEntryResponse,
  JournalEntryResponseSchema,
  LedgerAccountsResponseSchema,
  SaleResponseSchema,
  SystemAccountRoleWireSchema,
} from "@tali/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ApiHarness, startApi } from "../support/api-harness.js";
import { registerDevice, untrustedDeviceCases } from "../support/device-trust.js";
import {
  code,
  type InventoryWorld,
  inventoryWorld,
  keysDeep,
  MISSING_ID,
  type Role,
} from "../support/inventory-client.js";
import { LEDGER_ROUTES } from "../support/ledger-routes.js";
import { FORBIDDEN_SALES_KEYS, nonStringAmounts, salesClient } from "../support/sales-client.js";
import { bearer, type RegisteredActor } from "../support/tenancy-client.js";

describe("Build 3 Slice 6 ledger read API over HTTP", () => {
  let api: ApiHarness;
  let world: InventoryWorld;
  const seen: unknown[] = [];
  const client = () => salesClient(api, () => world);
  const as = (role: Role) => world.actors[role];

  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(async () => {
    world = await inventoryWorld(api);
  });
  afterEach(async () => {
    for (const body of seen.splice(0)) {
      const keys = keysDeep(body);
      expect(FORBIDDEN_SALES_KEYS.filter((key) => keys.has(key))).toEqual([]);
      expect(nonStringAmounts(body)).toEqual([]);
    }
    expect(await readSalesConsistency()).toEqual([]);
    expect(await readLedgerConsistency()).toEqual([]);
  });

  function record<T>(body: T): T {
    seen.push(body);
    return body;
  }

  /** A posted cash sale of 2 valued pieces at 50000 each, costing 70000 each. */
  async function postedSale() {
    const milk = await client().pricedItem({ price: "50000", stock: "10", stockCost: "700000" });
    const body = client().saleBody([[milk, "2"]]);
    const sale = SaleResponseSchema.parse((await client().sell(body).expect(201)).body);
    return { milk, sale, journals: await client().journalsOf(sale.saleId) };
  }

  async function entry(entryId: string, actor: RegisteredActor = as("OWNER")): Promise<JournalEntryResponse> {
    const response = await client().get(`ledger/entries/${entryId}`, actor).expect(200);
    return record(JournalEntryResponseSchema.parse(response.body));
  }

  async function balances(actor: RegisteredActor = as("OWNER")): Promise<Map<string, AccountBalanceResponse>> {
    const response = await client().get("ledger/balances", actor).expect(200);
    const rows = record(AccountBalancesResponseSchema.parse(response.body)).items;
    return new Map(rows.map((row) => [row.systemRole, row]));
  }

  const sumOf = (amounts: readonly { amountMinor: string }[]) =>
    amounts.reduce((sum, amount) => sum + BigInt(amount.amountMinor), 0n);

  function balanced(journal: JournalEntryResponse): boolean {
    const side = (direction: string) =>
      sumOf(journal.lines.filter((line) => line.direction === direction).map((line) => line.amount));
    return side("DEBIT") === side("CREDIT") && side("DEBIT") > 0n;
  }

  describe("permissions", () => {
    it("lets only the owner and the accountant read the ledger", async () => {
      const { journals } = await postedSale();
      for (const role of ["OWNER", "ACCOUNTANT"] as const) {
        const accounts = record(
          LedgerAccountsResponseSchema.parse((await client().get("ledger/accounts", as(role)).expect(200)).body),
        );
        expect(accounts.items.map((account) => account.systemRole).sort()).toEqual(
          [...SystemAccountRoleWireSchema.options].sort(),
        );
        const codes = accounts.items.map((account) => account.code);
        expect(codes).toEqual([...codes].sort());
        expect((await balances(as(role))).size).toBeGreaterThan(0);
        expect((await entry(journals.original, as(role))).entryId).toBe(journals.original);
      }
      const audit = (await readTenancySnapshot()).businessAudit.length;
      for (const role of ["MANAGER", "CASHIER", "STOCK_KEEPER"] as const) {
        for (const path of ["ledger/accounts", "ledger/balances", `ledger/entries/${journals.original}`]) {
          const response = await client().get(path, as(role));
          expect({ role, path, status: response.status, code: code(response.body) }).toEqual({
            role,
            path,
            status: 403,
            code: "PERMISSION_DENIED",
          });
        }
      }
      expect((await readTenancySnapshot()).businessAudit.length).toBe(audit);
    });
  });

  describe("journal entries and balances", () => {
    it("shows the balanced sale journal and its reversal, and balances that follow both", async () => {
      const { sale, journals } = await postedSale();
      const original = await entry(journals.original);
      expect(original).toMatchObject({
        entryId: journals.original,
        currency: "KES",
        entryKind: "ORIGINAL",
        source: { kind: "sale", id: sale.saleId },
        reversesEntryId: null,
        postingRule: "SALE_POSTED",
        postingRuleVersion: 1,
        locationId: sale.locationId,
        businessDate: sale.businessDate,
      });
      expect(balanced(original)).toBe(true);
      const roles = original.lines.map((line) => [line.systemRole, line.direction, line.amount.amountMinor]);
      expect(roles).toEqual(
        expect.arrayContaining([
          ["CASH_ON_HAND", "DEBIT", "100000"],
          ["SALES_REVENUE", "CREDIT", "100000"],
          ["COST_OF_GOODS_SOLD", "DEBIT", "140000"],
          ["INVENTORY", "CREDIT", "140000"],
        ]),
      );

      const afterSale = await balances();
      expect(afterSale.get("CASH_ON_HAND")?.balance).toEqual(client().money("100000"));
      expect(afterSale.get("SALES_REVENUE")?.balance).toEqual(client().money("100000"));
      expect(afterSale.get("COST_OF_GOODS_SOLD")?.balance).toEqual(client().money("140000"));
      expect(afterSale.get("INVENTORY")?.balance).toEqual(client().money("560000"));
      const rows = [...afterSale.values()];
      expect(sumOf(rows.map((row) => row.debitTotal))).toBe(sumOf(rows.map((row) => row.creditTotal)));

      await client().reverse(sale.saleId).expect(200);
      const { reversal } = await client().journalsOf(sale.saleId);
      if (reversal === undefined) throw new Error("expected a reversal journal entry");
      const reversed = await entry(reversal);
      expect(reversed).toMatchObject({
        entryKind: "REVERSAL",
        reversesEntryId: journals.original,
        source: { kind: "sale", id: sale.saleId },
        postingRule: "SALE_POSTED",
      });
      expect(balanced(reversed)).toBe(true);
      const flip = (direction: string) => (direction === "DEBIT" ? "CREDIT" : "DEBIT");
      const signature = (lines: JournalEntryResponse["lines"], turn: (direction: string) => string) =>
        lines.map((line) => `${line.accountId}:${turn(line.direction)}:${line.amount.amountMinor}`).sort();
      expect(signature(reversed.lines, flip)).toEqual(signature(original.lines, (direction) => direction));
      expect(await entry(journals.original)).toEqual(original);

      const afterReversal = await balances();
      for (const role of ["CASH_ON_HAND", "SALES_REVENUE", "COST_OF_GOODS_SOLD"]) {
        expect(afterReversal.get(role)?.balance).toEqual(client().money("0"));
      }
      expect(afterReversal.get("INVENTORY")?.balance).toEqual(client().money("700000"));
    });

    it("hides another tenant's entries and rejects a malformed or unknown entry ID", async () => {
      const { journals } = await postedSale();
      const foreign = await client().get(`ledger/entries/${journals.original}`, world.ownerB, world.b).expect(404);
      expect(code(foreign.body)).toBe("NOT_FOUND");
      expect(code((await client().get(`ledger/entries/${MISSING_ID}`).expect(404)).body)).toBe("NOT_FOUND");
      expect(code((await client().get("ledger/entries/not-a-uuid").expect(400)).body)).toBe("VALIDATION_FAILED");
      const query = await client().get("ledger/accounts?code=1000").expect(400);
      expect(code(query.body)).toBe("VALIDATION_FAILED");
      const otherChart = record(
        LedgerAccountsResponseSchema.parse(
          (await client().get("ledger/accounts", world.ownerB, world.b).expect(200)).body,
        ),
      );
      const ownChart = record(
        LedgerAccountsResponseSchema.parse((await client().get("ledger/accounts").expect(200)).body),
      );
      const ownIds = new Set(ownChart.items.map((account) => account.accountId));
      expect(otherChart.items.filter((account) => ownIds.has(account.accountId))).toEqual([]);
    });
  });

  describe("authentication and device trust", () => {
    it("is read-only and requires a bearer token and a trusted device when one is presented", async () => {
      const { journals } = await postedSale();
      expect(LEDGER_ROUTES).toHaveLength(3);
      expect(LEDGER_ROUTES.every((route) => route.startsWith("GET "))).toBe(true);
      const path = (route: (typeof LEDGER_ROUTES)[number]) =>
        route.split(" ")[1]?.replace(":businessId", world.a).replace(":entryId", journals.original) ?? "";

      for (const route of LEDGER_ROUTES) {
        expect({ route, status: (await client().http().get(path(route))).status }).toEqual({ route, status: 401 });
        const write = await client()
          .http()
          .post(path(route))
          .set(bearer(as("OWNER").token))
          .send({});
        expect({ route, status: write.status }).toEqual({ route, status: 404 });
      }

      const cases = await untrustedDeviceCases(api, as("OWNER"), world.a, { owner: world.ownerB, businessId: world.b });
      for (const [label, headers] of cases) {
        for (const route of LEDGER_ROUTES) {
          const response = await client()
            .http()
            .get(path(route))
            .set(bearer(as("OWNER").token))
            .set(headers);
          expect({ label, route, status: response.status, code: code(response.body) }).toEqual({
            label,
            route,
            status: 403,
            code: "DEVICE_NOT_TRUSTED",
          });
        }
      }
      const trusted = await registerDevice(api, as("OWNER"), world.a, "Back office");
      for (const route of LEDGER_ROUTES) {
        const response = await client()
          .http()
          .get(path(route))
          .set(bearer(as("OWNER").token))
          .set(trusted.headers);
        expect({ route, status: response.status }).toEqual({ route, status: 200 });
        record(response.body);
      }
    });
  });
});
