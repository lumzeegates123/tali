import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  UserDisabledError,
  UserNotRegisteredError,
  ValidationError,
} from "../../errors/application-error.js";
import { createTenancyHarness } from "../../testing/tenancy-harness.js";
import { CREATE_BUSINESS_OPERATION, createBusinessResultCodec } from "./create-business.js";

const KEY = "00000000-0000-4000-8000-000000000001";

async function setup() {
  const h = createTenancyHarness({ currencies: [defineCurrency("KES", 2), defineCurrency("JPY", 0)] });
  const owner = await h.registeredUser("owner");
  const auditBefore = h.auditWriter.all.length;
  return { h, owner, auditBefore };
}

const input = (
  overrides: Partial<{ name: string; currencyCode: string; timeZone: string; idempotencyKey: string | undefined }> = {},
) => ({
  name: "  Mama Put Provisions  ",
  currencyCode: "KES",
  timeZone: "Africa/Nairobi",
  idempotencyKey: KEY,
  ...overrides,
});

describe("CreateBusiness", () => {
  it("creates the business, its default location and the creator's OWNER membership", async () => {
    const { h, owner } = await setup();
    const { result, replayed } = await h.createBusiness.execute(owner.context, input());
    expect(replayed).toBe(false);
    expect(result.business).toMatchObject({
      name: "Mama Put Provisions",
      currencyCode: "KES",
      timeZone: "Africa/Nairobi",
      status: "ACTIVE",
      createdByUserId: owner.userId,
    });
    expect(result.location).toMatchObject({
      businessId: result.business.id,
      name: "Mama Put Provisions",
      isDefault: true,
      status: "ACTIVE",
    });
    expect(result.membership).toMatchObject({
      businessId: result.business.id,
      userId: owner.userId,
      role: "OWNER",
      status: "ACTIVE",
      version: 1,
    });
    expect(h.store.businesses).toEqual([result.business]);
    expect(h.store.locations).toEqual([result.location]);
    expect(h.store.memberships).toEqual([result.membership]);
  });

  it("accepts any approved currency and canonicalizes the time zone", async () => {
    const { h, owner } = await setup();
    const { result } = await h.createBusiness.execute(owner.context, input({ currencyCode: "JPY", timeZone: "UTC" }));
    expect(result.business).toMatchObject({ currencyCode: "JPY", timeZone: "Etc/UTC" });
  });

  it("writes business, location and membership audit records in the business stream", async () => {
    const { h, owner, auditBefore } = await setup();
    const { result } = await h.createBusiness.execute(owner.context, input());
    const actor = { type: "user", userId: owner.userId, membershipId: result.membership.id };
    expect(h.auditWriter.all).toHaveLength(auditBefore + 3);
    expect(h.auditWriter.businessRecords).toEqual([
      expect.objectContaining({
        action: "business.created",
        entityId: result.business.id,
        businessId: result.business.id,
        actor,
        idempotencyKey: KEY,
        payload: { currencyCode: "KES", timeZone: "Africa/Nairobi", status: "ACTIVE" },
      }),
      expect.objectContaining({
        action: "location.created",
        entityId: result.location.id,
        businessId: result.business.id,
        locationId: result.location.id,
        actor,
        payload: { isDefault: true, status: "ACTIVE" },
      }),
      expect.objectContaining({
        action: "membership.created",
        entityId: result.membership.id,
        businessId: result.business.id,
        actor,
        payload: { userId: owner.userId, role: "OWNER", status: "ACTIVE" },
      }),
    ]);
    expect(JSON.stringify(h.auditWriter.businessRecords)).not.toContain("Mama Put");
  });

  it("fingerprints the normalized command, not the raw input or the key", async () => {
    const { h, owner } = await setup();
    await h.createBusiness.execute(owner.context, input());
    expect(h.hasher.calls.at(-1)).toMatchObject({
      operation: CREATE_BUSINESS_OPERATION,
      commandSchemaVersion: 1,
      command: {
        kind: "object",
        entries: [
          { key: "currencyCode", value: { kind: "string", value: "KES" } },
          { key: "name", value: { kind: "string", value: "Mama Put Provisions" } },
          { key: "timeZone", value: { kind: "string", value: "Africa/Nairobi" } },
        ],
      },
    });
  });

  it("replays the same request with the same key: same result, no new records or audit", async () => {
    const { h, owner } = await setup();
    const first = await h.createBusiness.execute(owner.context, input());
    const auditCount = h.auditWriter.all.length;
    const second = await h.createBusiness.execute(owner.context, input());
    expect(second).toEqual({ result: first.result, replayed: true });
    expect(h.store.businesses).toHaveLength(1);
    expect(h.auditWriter.all).toHaveLength(auditCount);
  });

  it("replays an equivalent request (same normalized command)", async () => {
    const { h, owner } = await setup();
    await h.createBusiness.execute(owner.context, input());
    const second = await h.createBusiness.execute(
      owner.context,
      input({ name: "Mama Put Provisions", timeZone: "africa/nairobi" }),
    );
    expect(second.replayed).toBe(true);
  });

  it("rejects the same key with a different command", async () => {
    const { h, owner } = await setup();
    await h.createBusiness.execute(owner.context, input());
    await expect(h.createBusiness.execute(owner.context, input({ name: "Another Shop" }))).rejects.toThrow(
      IdempotencyKeyReusedError,
    );
    expect(h.store.businesses).toHaveLength(1);
  });

  it("scopes the key to the user", async () => {
    const { h, owner } = await setup();
    const other = await h.registeredUser("other");
    await h.createBusiness.execute(owner.context, input());
    const second = await h.createBusiness.execute(other.context, input());
    expect(second.replayed).toBe(false);
    expect(h.store.businesses).toHaveLength(2);
  });

  it("requires an idempotency key", async () => {
    const { h, owner } = await setup();
    await expect(h.createBusiness.execute(owner.context, input({ idempotencyKey: undefined }))).rejects.toThrow(
      IdempotencyKeyRequiredError,
    );
    await expect(h.createBusiness.execute(owner.context, input({ idempotencyKey: "abc" }))).rejects.toThrow(
      ValidationError,
    );
  });

  it.each([
    ["an empty name", { name: "   " }],
    ["a name over 120 characters", { name: "x".repeat(121) }],
    ["a malformed currency", { currencyCode: "kes" }],
    ["a currency outside the reference data", { currencyCode: "EUR" }],
    ["an offset time zone", { timeZone: "+01:00" }],
    ["an unknown time zone", { timeZone: "Mars/Olympus_Mons" }],
  ])("rejects %s without writing anything", async (_name, override) => {
    const { h, owner, auditBefore } = await setup();
    await expect(h.createBusiness.execute(owner.context, input(override))).rejects.toThrow(ValidationError);
    expect(h.store.businesses).toHaveLength(0);
    expect(h.idempotencyStore.records).toHaveLength(0);
    expect(h.auditWriter.all).toHaveLength(auditBefore);
  });

  it("does not store a rejected attempt, so the key can be retried with a valid command", async () => {
    const { h, owner } = await setup();
    await expect(h.createBusiness.execute(owner.context, input({ currencyCode: "EUR" }))).rejects.toThrow(
      ValidationError,
    );
    await expect(h.createBusiness.execute(owner.context, input())).resolves.toMatchObject({ replayed: false });
  });

  it("rejects a DISABLED user", async () => {
    const { h, owner } = await setup();
    h.setUserStatus(owner, "DISABLED");
    await expect(h.createBusiness.execute(owner.context, input())).rejects.toThrow(UserDisabledError);
    expect(h.store.businesses).toHaveLength(0);
  });

  it("rejects a context whose user does not exist", async () => {
    const { h, owner } = await setup();
    const ghost = { ...owner.context, userId: h.ids.newId("User") };
    await expect(h.createBusiness.execute(ghost, input())).rejects.toThrow(UserNotRegisteredError);
  });

  it.each([
    ["the business insert", "businesses.insert"],
    ["the location insert", "locations.insert"],
    ["the membership insert", "memberships.insert"],
    ["the business audit", "audit.business.created"],
    ["the location audit", "audit.location.created"],
    ["the membership audit", "audit.membership.created"],
  ])("leaves nothing behind when %s fails", async (_name, operation) => {
    const { h, owner, auditBefore } = await setup();
    const failures = operation.startsWith("audit.") ? h.auditWriter.failures : h.store.failures;
    failures.failNext(operation);
    await expect(h.createBusiness.execute(owner.context, input())).rejects.toThrow(/injected failure/);
    expect(h.store.businesses).toHaveLength(0);
    expect(h.store.locations).toHaveLength(0);
    expect(h.store.memberships).toHaveLength(0);
    expect(h.idempotencyStore.records).toHaveLength(0);
    expect(h.auditWriter.all).toHaveLength(auditBefore);
    // The same key then succeeds: the failed attempt claimed nothing.
    await expect(h.createBusiness.execute(owner.context, input())).resolves.toMatchObject({ replayed: false });
  });

  it("round-trips its result through the codec", async () => {
    const { h, owner } = await setup();
    const { result } = await h.createBusiness.execute(owner.context, input());
    const stored: unknown = JSON.parse(JSON.stringify(createBusinessResultCodec.encode(result)));
    expect(createBusinessResultCodec.decode(stored as never)).toEqual(result);
  });

  it("lets one user create several businesses, each with its own default location", async () => {
    const { h, owner } = await setup();
    await h.createBusiness.execute(owner.context, input());
    await h.createBusiness.execute(
      owner.context,
      input({ name: "Second", idempotencyKey: "00000000-0000-4000-8000-000000000002" }),
    );
    expect(h.store.businesses).toHaveLength(2);
    expect(h.store.locations.filter((location) => location.isDefault)).toHaveLength(2);
  });
});
