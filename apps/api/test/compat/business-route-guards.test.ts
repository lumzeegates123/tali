import type { Server } from "node:http";
import { Controller, type DynamicModule, Get, type INestApplication, UseGuards } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FakeIdentityProvider, FixedClock } from "@tali/application/testing";
import { loadServerConfig } from "@tali/config/server";
import { createDatabase } from "@tali/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { AuthenticationGuard } from "../../src/auth/authentication.guard.js";
import { BusinessContextGuard } from "../../src/auth/business-context.guard.js";
import { RegisteredUserGuard } from "../../src/auth/registered-user.guard.js";
import { BUSINESS_SCOPED_PATH } from "../../src/business/business-scoped.controller.js";
import { createApiApplication } from "../../src/bootstrap.js";
import { type ApiRuntime, createApiRuntime } from "../../src/composition/api-runtime.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { type GuardRef, metadataRoutes, registeredRoutes, type RouteInfo } from "../support/route-inventory.js";

/*
 * Permanent tenancy regression check (Build 1 Slice 3 audit): every route that
 * carries a `:businessId` parameter must live under `v1/businesses/:businessId`
 * and run exactly AuthenticationGuard then BusinessContextGuard, so its
 * handler only ever sees a BusinessContext resolved server-side for the
 * route's business. Routes are read from Nest's controller metadata, and that
 * inventory must equal the routes Express actually registered, so a controller
 * the scan cannot see fails the check instead of escaping it.
 */

const REQUIRED_BUSINESS_GUARDS: readonly GuardRef[] = [AuthenticationGuard, BusinessContextGuard];
const BUSINESS_PREFIX = `/${BUSINESS_SCOPED_PATH}`;

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

  it("finds the Build 1 business-scoped routes", () => {
    const business = routes.filter((route) => route.path.startsWith(BUSINESS_PREFIX));
    expect(business.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /v1/businesses/:businessId",
      "GET /v1/businesses/:businessId/locations",
      "GET /v1/businesses/:businessId/members",
    ]);
  });

  it("protects every business-scoped route with AuthenticationGuard then BusinessContextGuard", () => {
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

describe("the check fails for an unprotected business route", () => {
  @Controller("v1/businesses/:businessId/rogue")
  class UnguardedController {
    @Get()
    read(): string {
      return "leak";
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
    expect(violations).toHaveLength(5);
    expect(violations.join("\n")).toMatch(/GET \/v1\/businesses\/:businessId\/rogue .*guards \[\]/);
    expect(violations.join("\n")).toMatch(/reversed .*guards \[BusinessContextGuard, AuthenticationGuard\]/);
    expect(violations.join("\n")).toMatch(/user-only .*guards \[AuthenticationGuard, RegisteredUserGuard\]/);
    expect(violations.join("\n")).toMatch(/\/v1\/reports\/:businessId .*must live under/);
    expect(violations.join("\n")).toMatch(/\/v1\/reports\/:businessId .*BusinessContextGuard outside/);
  });
});
