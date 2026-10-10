import type { Server } from "node:http";
import { Controller, type DynamicModule, Get, type INestApplication, UseGuards } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FakeIdentityProvider, FixedClock } from "@tali/application/testing";
import { loadServerConfig } from "@tali/config/server";
import { createDatabase } from "@tali/database";
import {
  CancelStocktakeRequestSchema,
  ClearLowStockThresholdRequestSchema,
  CreateStocktakeRequestSchema,
  PostGoodsReceiptRequestSchema,
  PostStocktakeRequestSchema,
  RecordAdjustmentRequestSchema,
  RecordOpeningStockRequestSchema,
  RecordStocktakeCountRequestSchema,
  RecordWriteOffRequestSchema,
  RemoveStocktakeLineRequestSchema,
  ReverseDocumentRequestSchema,
  SetLowStockThresholdRequestSchema,
} from "@tali/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { AuthenticationGuard } from "../../src/auth/authentication.guard.js";
import { BusinessContextGuard } from "../../src/auth/business-context.guard.js";
import { DeviceContextGuard } from "../../src/auth/device-context.guard.js";
import { RegisteredUserGuard } from "../../src/auth/registered-user.guard.js";
import { BUSINESS_SCOPED_PATH } from "../../src/business/business-scoped.controller.js";
import { createApiApplication } from "../../src/bootstrap.js";
import { type ApiRuntime, createApiRuntime } from "../../src/composition/api-runtime.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { type GuardRef, metadataRoutes, registeredRoutes, type RouteInfo } from "../support/route-inventory.js";

/*
 * Permanent tenancy regression check (Build 1 Slice 3 audit, extended in
 * Slice 5): every route that carries a `:businessId` parameter must live under
 * `v1/businesses/:businessId` and run exactly AuthenticationGuard, then
 * BusinessContextGuard, then DeviceContextGuard, so its handler only ever sees
 * a BusinessContext resolved server-side for the route's business, with a
 * device set only after verification against that business. Routes are read
 * from Nest's controller metadata, and that inventory must equal the routes
 * Express actually registered, so a controller the scan cannot see fails the
 * check instead of escaping it.
 */

const REQUIRED_BUSINESS_GUARDS: readonly GuardRef[] = [AuthenticationGuard, BusinessContextGuard, DeviceContextGuard];
const BUSINESS_PREFIX = `/${BUSINESS_SCOPED_PATH}`;

const TENANCY_AND_CATALOG_ROUTES = [
  "GET /v1/businesses/:businessId",
  "GET /v1/businesses/:businessId/catalog/units",
  "GET /v1/businesses/:businessId/categories",
  "GET /v1/businesses/:businessId/categories/:categoryId",
  "GET /v1/businesses/:businessId/currency",
  "GET /v1/businesses/:businessId/devices",
  "GET /v1/businesses/:businessId/locations",
  "GET /v1/businesses/:businessId/members",
  "GET /v1/businesses/:businessId/products",
  "GET /v1/businesses/:businessId/products/:productId",
  "GET /v1/businesses/:businessId/products/:productId/packs",
  "GET /v1/businesses/:businessId/products/:productId/prices",
  "PATCH /v1/businesses/:businessId",
  "PATCH /v1/businesses/:businessId/categories/:categoryId",
  "PATCH /v1/businesses/:businessId/products/:productId",
  "POST /v1/businesses/:businessId/categories",
  "POST /v1/businesses/:businessId/categories/:categoryId/archive",
  "POST /v1/businesses/:businessId/devices",
  "POST /v1/businesses/:businessId/devices/:deviceId/revoke",
  "POST /v1/businesses/:businessId/invitations",
  "POST /v1/businesses/:businessId/invitations/:invitationId/revoke",
  "POST /v1/businesses/:businessId/members/:membershipId/reactivate",
  "POST /v1/businesses/:businessId/members/:membershipId/role",
  "POST /v1/businesses/:businessId/members/:membershipId/suspend",
  "POST /v1/businesses/:businessId/packs/:packId/retire",
  "POST /v1/businesses/:businessId/products",
  "POST /v1/businesses/:businessId/products/:productId/archive",
  "POST /v1/businesses/:businessId/products/:productId/packs",
  "POST /v1/businesses/:businessId/products/:productId/reactivate",
  "PUT /v1/businesses/:businessId/products/:productId/price",
];

/** Build 2 Slices 5 and 6: the only stock routes, all at the server-resolved default location. */
const INVENTORY_ROUTES = [
  "GET /v1/businesses/:businessId/inventory/balances",
  "GET /v1/businesses/:businessId/inventory/items/:variantId",
  "GET /v1/businesses/:businessId/inventory/items/:variantId/movements",
  "GET /v1/businesses/:businessId/inventory/opening-batches/:openingBatchId",
  "GET /v1/businesses/:businessId/inventory/goods-receipts/:goodsReceiptId",
  "GET /v1/businesses/:businessId/inventory/adjustments/:adjustmentId",
  "GET /v1/businesses/:businessId/inventory/stocktakes",
  "GET /v1/businesses/:businessId/inventory/stocktakes/:stocktakeId",
  "GET /v1/businesses/:businessId/inventory/stocktakes/:stocktakeId/lines",
  "POST /v1/businesses/:businessId/inventory/opening-stock",
  "POST /v1/businesses/:businessId/inventory/goods-receipts",
  "POST /v1/businesses/:businessId/inventory/adjustments",
  "POST /v1/businesses/:businessId/inventory/write-offs",
  "POST /v1/businesses/:businessId/inventory/stocktakes",
  "POST /v1/businesses/:businessId/inventory/goods-receipts/:goodsReceiptId/reverse",
  "POST /v1/businesses/:businessId/inventory/adjustments/:adjustmentId/reverse",
  "PUT /v1/businesses/:businessId/inventory/items/:variantId/threshold",
  "POST /v1/businesses/:businessId/inventory/items/:variantId/threshold/clear",
  "PUT /v1/businesses/:businessId/inventory/stocktakes/:stocktakeId/lines/:variantId",
  "POST /v1/businesses/:businessId/inventory/stocktakes/:stocktakeId/lines/:variantId/remove",
  "POST /v1/businesses/:businessId/inventory/stocktakes/:stocktakeId/post",
  "POST /v1/businesses/:businessId/inventory/stocktakes/:stocktakeId/cancel",
];

const VARIANT = "019a0000-0000-7000-8000-000000000001";
const DIRECT = { variantId: VARIANT, quantityMinor: "1", unit: "PIECE" };
/** Every inventory mutation body schema with a minimal valid body. */
interface BodySchema {
  safeParse(value: unknown): { readonly success: boolean };
}
const INVENTORY_MUTATION_BODIES: readonly (readonly [string, BodySchema, Record<string, unknown>])[] = [
  ["opening stock", RecordOpeningStockRequestSchema, { lines: [DIRECT] }],
  ["goods receipt", PostGoodsReceiptRequestSchema, { lines: [DIRECT] }],
  [
    "adjustment",
    RecordAdjustmentRequestSchema,
    { lines: [{ ...DIRECT, direction: "INCREASE" }], reasonCode: "FOUND_STOCK" },
  ],
  ["write-off", RecordWriteOffRequestSchema, { lines: [DIRECT], reasonCode: "DAMAGED" }],
  ["reversal", ReverseDocumentRequestSchema, { reason: "entered twice" }],
  [
    "set threshold",
    SetLowStockThresholdRequestSchema,
    { expectedVersion: 0, threshold: { quantityMinor: "1", unit: "PIECE" } },
  ],
  ["clear threshold", ClearLowStockThresholdRequestSchema, { expectedVersion: 1 }],
  ["create stocktake", CreateStocktakeRequestSchema, {}],
  ["count", RecordStocktakeCountRequestSchema, { count: { quantityMinor: "1", unit: "PIECE" } }],
  ["remove line", RemoveStocktakeLineRequestSchema, { expectedVersion: 1 }],
  ["post stocktake", PostStocktakeRequestSchema, { expectedVersion: 1 }],
  ["cancel stocktake", CancelStocktakeRequestSchema, { expectedVersion: 1 }],
];

const guardName = (guard: GuardRef) => (typeof guard === "function" ? guard.name : guard.constructor.name);

/** Human-readable violations; empty means every business-scoped route is protected. */
function businessRouteViolations(routes: readonly RouteInfo[]): string[] {
  const violations: string[] = [];
  for (const route of routes) {
    const label = `${route.method} ${route.path} (${route.handler})`;
    const businessScoped = route.path === BUSINESS_PREFIX || route.path.startsWith(`${BUSINESS_PREFIX}/`);
    if (route.path.includes(":businessId") && !businessScoped) {
      violations.push(`${label}: a :businessId route must live under ${BUSINESS_PREFIX}`);
    }
    if (businessScoped) {
      const same =
        route.guards.length === REQUIRED_BUSINESS_GUARDS.length &&
        route.guards.every((guard, index) => guard === REQUIRED_BUSINESS_GUARDS[index]);
      if (!same) {
        violations.push(
          `${label}: guards [${route.guards.map(guardName).join(", ")}], required [${REQUIRED_BUSINESS_GUARDS.map(guardName).join(", ")}]`,
        );
      }
    }
    if (!businessScoped && route.guards.includes(BusinessContextGuard)) {
      violations.push(`${label}: BusinessContextGuard outside ${BUSINESS_PREFIX}`);
    }
    if (!businessScoped && route.guards.includes(DeviceContextGuard)) {
      violations.push(`${label}: DeviceContextGuard outside ${BUSINESS_PREFIX}`);
    }
  }
  return violations;
}

const silentLogger = new JsonLogger({ service: "route-guards", level: "fatal", sink: () => undefined });
const BASE_ENV = {
  DATABASE_URL: "postgresql://tali_app:unused@127.0.0.1:1/tali_test",
  OBJECT_STORAGE_PROVIDER: "memory",
  QUEUE_PROVIDER: "memory",
  LOG_LEVEL: "fatal",
  SERVICE_NAME: "tali-route-guards",
} as const;

/** A runtime whose database is never contacted: routing is built without any query. */
async function runtimeFor(env: "test" | "local"): Promise<ApiRuntime> {
  const config = loadServerConfig({
    ...BASE_ENV,
    TALI_ENV: env,
    IDENTITY_PROVIDER: env === "local" ? "local" : "fake",
  });
  return createApiRuntime(config, {
    logger: silentLogger,
    database: createDatabase({ connectionString: config.database.url, applicationName: "tali-route-guards" }),
    ...(env === "test" ? { identityProvider: new FakeIdentityProvider(new FixedClock("2026-09-29T00:00:00Z")) } : {}),
  });
}

describe.each(["test", "local"] as const)("business route guards (TALI_ENV=%s)", (env) => {
  let runtime: ApiRuntime;
  let app: INestApplication<Server>;
  let routes: RouteInfo[];

  beforeAll(async () => {
    runtime = await runtimeFor(env);
    app = await createApiApplication(runtime);
    await app.init();
    routes = metadataRoutes(app);
  });
  afterAll(async () => {
    await app.close();
    await runtime.close();
  });

  it("reads exactly the routes Express registered", () => {
    const fromMetadata = routes.map((route) => `${route.method} ${route.path}`).sort();
    expect(fromMetadata).toEqual(registeredRoutes(app).sort());
  });

  it("finds the Build 1 and Build 2 catalog and inventory business-scoped routes", () => {
    const business = routes.filter((route) => route.path.startsWith(BUSINESS_PREFIX));
    expect(business.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [...TENANCY_AND_CATALOG_ROUTES, ...INVENTORY_ROUTES].sort(),
    );
  });

  it("mounts exactly the 22 inventory and stocktake routes", () => {
    const inventory = routes.filter((route) => /inventor|stock|movement|balance|count/i.test(route.path));
    expect(inventory.map((route) => `${route.method} ${route.path}`).sort()).toEqual([...INVENTORY_ROUTES].sort());
    expect(INVENTORY_ROUTES).toHaveLength(22);
  });

  it("guards every inventory route with exactly AuthenticationGuard, BusinessContextGuard, DeviceContextGuard", () => {
    const inventory = routes.filter((route) => route.path.startsWith(`${BUSINESS_PREFIX}/inventory`));
    expect(inventory).toHaveLength(22);
    for (const route of inventory) {
      expect({ route: `${route.method} ${route.path}`, guards: route.guards }).toEqual({
        route: `${route.method} ${route.path}`,
        guards: REQUIRED_BUSINESS_GUARDS,
      });
    }
  });

  it("names no location in any inventory path", () => {
    expect(routes.filter((route) => route.path.includes(":locationId"))).toEqual([]);
  });

  it("serves invitation acceptance as a user-level route with no business or device guard", () => {
    const accept = routes.find((route) => route.path === "/v1/invitations/accept");
    expect(accept).toMatchObject({ method: "POST", guards: [AuthenticationGuard, RegisteredUserGuard] });
  });

  it("protects every business-scoped route with AuthenticationGuard, BusinessContextGuard, DeviceContextGuard", () => {
    expect(businessRouteViolations(routes)).toEqual([]);
  });

  it("puts authentication first on every guarded route", () => {
    for (const route of routes) {
      if (route.guards.length === 0) continue;
      expect({ route: route.handler, first: route.guards[0] }).toEqual({
        route: route.handler,
        first: AuthenticationGuard,
      });
    }
  });
});

describe("inventory mutation bodies", () => {
  it.each(INVENTORY_MUTATION_BODIES)("%s rejects a client locationId", (_name, schema, valid) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, locationId: VARIANT }).success).toBe(false);
  });
});

describe("the check fails for an unprotected business route", () => {
  @Controller("v1/businesses/:businessId/rogue")
  class UnguardedController {
    @Get()
    read(): string {
      return "leak";
    }
  }

  @Controller(BUSINESS_SCOPED_PATH)
  class MissingDeviceGuardController {
    @Get("no-device-check")
    @UseGuards(AuthenticationGuard, BusinessContextGuard)
    noDevice(): string {
      return "unverified";
    }
  }

  @Controller(BUSINESS_SCOPED_PATH)
  class MethodGuardedWrongController {
    @Get("reversed")
    @UseGuards(BusinessContextGuard, AuthenticationGuard)
    reversed(): string {
      return "reversed";
    }

    @Get("user-only")
    @UseGuards(AuthenticationGuard, RegisteredUserGuard)
    userOnly(): string {
      return "user";
    }
  }

  @Controller("v1/reports/:businessId")
  @UseGuards(AuthenticationGuard, BusinessContextGuard)
  class MisplacedController {
    @Get()
    read(): string {
      return "misplaced";
    }
  }

  let runtime: ApiRuntime;
  let app: INestApplication<Server>;
  beforeAll(async () => {
    runtime = await runtimeFor("test");
    const base: DynamicModule = AppModule.register(runtime);
    const withRogues: DynamicModule = {
      ...base,
      controllers: [
        ...(base.controllers ?? []),
        UnguardedController,
        MissingDeviceGuardController,
        MethodGuardedWrongController,
        MisplacedController,
      ],
    };
    app = await NestFactory.create(withRogues, { logger: false, abortOnError: false });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await runtime.close();
  });

  it("reports each violation and nothing about the real routes", () => {
    const violations = businessRouteViolations(metadataRoutes(app));
    expect(violations).toHaveLength(6);
    expect(violations.join("\n")).toMatch(/GET \/v1\/businesses\/:businessId\/rogue .*guards \[\]/);
    expect(violations.join("\n")).toMatch(/no-device-check .*guards \[AuthenticationGuard, BusinessContextGuard\]/);
    expect(violations.join("\n")).toMatch(/reversed .*guards \[BusinessContextGuard, AuthenticationGuard\]/);
    expect(violations.join("\n")).toMatch(/user-only .*guards \[AuthenticationGuard, RegisteredUserGuard\]/);
    expect(violations.join("\n")).toMatch(/\/v1\/reports\/:businessId .*must live under/);
    expect(violations.join("\n")).toMatch(/\/v1\/reports\/:businessId .*BusinessContextGuard outside/);
  });
});
