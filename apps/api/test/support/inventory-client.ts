import { randomUUID } from "node:crypto";
import { resetTenancyTables, tenancyFixtures } from "@tali/database/testing";
import { uuidV7IdGenerator } from "@tali/integrations/platform";
import {
  ErrorEnvelopeSchema,
  type MembershipRoleWireSchema,
  PackResponseSchema,
  ProductResponseSchema,
} from "@tali/shared";
import request from "supertest";
import type { ApiHarness } from "./api-harness.js";
import { bearer, createBusinessAs, registerActor, type RegisteredActor } from "./tenancy-client.js";

export type Role = (typeof MembershipRoleWireSchema.options)[number];
export const ROLES: readonly Role[] = ["OWNER", "MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"];
export const MISSING_ID = "0190a000-0000-7000-8000-00000000dead";

export const code = (body: unknown) => ErrorEnvelopeSchema.parse(body).error.code;

/** Two businesses: A with one member of every role, B with only its owner. */
export interface InventoryWorld {
  readonly a: string;
  readonly b: string;
  readonly actors: Readonly<Record<Role, RegisteredActor>>;
  readonly ownerB: RegisteredActor;
}

export async function inventoryWorld(api: ApiHarness): Promise<InventoryWorld> {
  await resetTenancyTables();
  const ownerA = await registerActor(api, `owner-a-${randomUUID()}`, "Amani");
  const ownerB = await registerActor(api, `owner-b-${randomUUID()}`, "Baraka");
  const a = (await createBusinessAs(api, ownerA, { name: "Duka A" })).business.id;
  const b = (await createBusinessAs(api, ownerB, { name: "Duka B" })).business.id;
  const actors: Partial<Record<Role, RegisteredActor>> = { OWNER: ownerA };
  for (const role of ROLES.filter((r) => r !== "OWNER")) {
    const actor = await registerActor(api, `${role.toLowerCase()}-${randomUUID()}`, role);
    await tenancyFixtures.insertMembership({
      id: uuidV7IdGenerator.newId("membership"),
      businessId: a,
      userId: actor.userId,
      role,
    });
    actors[role] = actor;
  }
  return { a, b, ownerB, actors: actors as Record<Role, RegisteredActor> };
}

export const businessUrl = (businessId: string, path: string) => `/v1/businesses/${businessId}/${path}`;

export interface StockItem {
  readonly productId: string;
  readonly variantId: string;
  readonly version: number;
}

/** Keys that must never appear anywhere in an inventory or stocktake response. */
export const FORBIDDEN_INVENTORY_KEYS = [
  "businessId",
  "business_id",
  "actorMembershipId",
  "deviceId",
  "correlationId",
  "recordedAt",
  "recordedByMembershipId",
  "createdByMembershipId",
  "postedByMembershipId",
  "cancelledByMembershipId",
  "reversedByMembershipId",
  "balanceVersionAtCount",
  "idempotencyKey",
] as const;

/** Every key of every object in a JSON value, at any depth. */
export function keysDeep(value: unknown): Set<string> {
  const keys = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        keys.add(key);
        visit(child);
      }
    }
  };
  visit(value);
  return keys;
}

const STRING_QUANTITY_KEYS = new Set(["quantityMinor", "factorMinor"]);

/** Paths of quantity fields that are not strings (a JSON number or anything else). */
export function nonStringQuantities(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => nonStringQuantities(item, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(STRING_QUANTITY_KEYS.has(key) && typeof child !== "string" ? [`${path}.${key}`] : []),
    ...nonStringQuantities(child, `${path}.${key}`),
  ]);
}

/** HTTP helpers bound to one harness and world. */
export function inventoryClient(api: ApiHarness, world: () => InventoryWorld) {
  const http = () => request(api.app.getHttpServer());
  const as = (role: Role) => world().actors[role];
  const url = (path: string, businessId = world().a) => businessUrl(businessId, path);

  async function product(
    body: Record<string, unknown> = {},
    actor: RegisteredActor = as("OWNER"),
    businessId = world().a,
  ): Promise<StockItem> {
    const response = await http()
      .post(url("products", businessId))
      .set(bearer(actor.token))
      .set("idempotency-key", randomUUID())
      .send({ name: `Peak Milk ${randomUUID().slice(0, 8)}`, stockUnit: "PIECE", trackInventory: true, ...body })
      .expect(201);
    const created = ProductResponseSchema.parse(response.body);
    return { productId: created.id, variantId: created.variantId, version: created.version };
  }

  async function pack(item: StockItem, factorMinor = "24", businessId = world().a): Promise<string> {
    const response = await http()
      .post(url(`products/${item.productId}/packs`, businessId))
      .set(bearer(as("OWNER").token))
      .set("idempotency-key", randomUUID())
      .send({ name: `Crate ${randomUUID().slice(0, 8)}`, factorMinor })
      .expect(201);
    return PackResponseSchema.parse(response.body).id;
  }

  async function retirePack(packId: string): Promise<void> {
    await http()
      .post(url(`packs/${packId}/retire`))
      .set(bearer(as("OWNER").token))
      .expect(200);
  }

  async function archive(item: StockItem): Promise<void> {
    await http()
      .post(url(`products/${item.productId}/archive`))
      .set(bearer(as("OWNER").token))
      .send({ expectedVersion: item.version })
      .expect(200);
  }

  function keyed(
    path: string,
    body: unknown,
    actor: RegisteredActor = as("OWNER"),
    /** `null` sends no Idempotency-Key header. */
    key: string | null = randomUUID(),
    businessId = world().a,
  ) {
    const call = http().post(url(path, businessId)).set(bearer(actor.token));
    return (key === null ? call : call.set("idempotency-key", key)).send(body as object);
  }

  /** Receives whole pieces of each variant at the default location. */
  async function receive(lines: readonly (readonly [StockItem, string])[], actor: RegisteredActor = as("OWNER")) {
    return keyed(
      "inventory/goods-receipts",
      { lines: lines.map(([item, quantityMinor]) => ({ variantId: item.variantId, quantityMinor, unit: "PIECE" })) },
      actor,
    ).expect(201);
  }

  const get = (path: string, actor: RegisteredActor = as("OWNER"), businessId = world().a) =>
    http().get(url(path, businessId)).set(bearer(actor.token));

  const post = (path: string, body: unknown, actor: RegisteredActor = as("OWNER"), businessId = world().a) =>
    http()
      .post(url(path, businessId))
      .set(bearer(actor.token))
      .send(body as object);

  const put = (path: string, body: unknown, actor: RegisteredActor = as("OWNER"), businessId = world().a) =>
    http()
      .put(url(path, businessId))
      .set(bearer(actor.token))
      .send(body as object);

  return { http, as, url, product, pack, retirePack, archive, keyed, receive, get, post, put };
}
