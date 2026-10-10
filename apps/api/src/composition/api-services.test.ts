import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDatabase, type Database, type DatabaseRepositories } from "@tali/database";
import {
  nodeOneTimeSecretGenerator,
  Sha256FingerprintHasher,
  sha256SecretHasher,
  uuidV7IdGenerator,
} from "@tali/integrations/platform";
import { afterAll, describe, expect, it } from "vitest";
import { systemClock } from "./api-runtime.js";
import { composeApiServices, INVENTORY_SERVICE_KEYS } from "./api-services.js";

const INVENTORY_REPOSITORIES: readonly (keyof DatabaseRepositories)[] = [
  "inventoryMovements",
  "inventoryBalances",
  "inventoryOpeningBatches",
  "goodsReceipts",
  "inventoryAdjustments",
  "inventoryThresholds",
  "stocktakes",
  "stocktakeLines",
  "inventoryItems",
  "businessIdempotency",
  "auditWriter",
];

/** A real database adapter on an address that is never contacted: composition runs no query. */
const database = createDatabase({
  connectionString: "postgresql://tali_app:unused@127.0.0.1:1/tali_test",
  applicationName: "tali-composition-test",
});
const read = new Set<string | symbol>();
const recording: Database = {
  unitOfWork: database.unitOfWork,
  ping: () => database.ping(),
  disconnect: () => database.disconnect(),
  repositories: new Proxy(database.repositories, {
    get(target, key, receiver) {
      read.add(key);
      return Reflect.get(target, key, receiver) as unknown;
    },
  }),
};

describe("composeApiServices inventory composition (Build 2 Slices 5 and 6)", () => {
  afterAll(async () => {
    await database.disconnect();
  });

  const services = composeApiServices({
    database: recording,
    clock: systemClock,
    ids: uuidV7IdGenerator,
    hasher: new Sha256FingerprintHasher(),
    secrets: nodeOneTimeSecretGenerator,
    secretHasher: sha256SecretHasher,
  });

  it("composes every inventory and stocktake use case", () => {
    expect(INVENTORY_SERVICE_KEYS).toHaveLength(22);
    expect(new Set(INVENTORY_SERVICE_KEYS).size).toBe(22);
    for (const key of INVENTORY_SERVICE_KEYS) {
      expect({ key, execute: typeof services[key].execute }).toEqual({ key, execute: "function" });
    }
  });

  it("wires them to the database's own inventory repositories, idempotency store and audit writer", () => {
    for (const repository of INVENTORY_REPOSITORIES) {
      expect({ repository, read: read.has(repository) }).toEqual({ repository, read: true });
      expect(database.repositories[repository]).toBeDefined();
    }
  });

  it("uses no test double, in-memory store or temporary reader", () => {
    const source = readFileSync(fileURLToPath(new URL("./api-services.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/@tali\/application\/testing|InMemory|[Mm]ock|[Ff]ake|Stub/);
  });
});
