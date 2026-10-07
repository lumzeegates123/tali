import { describe, expect, it } from "vitest";
import { LocalSignInRequestSchema, LocalSignInResponseSchema } from "./local-sign-in.js";
import {
  BusinessCurrencyResponseSchema,
  BusinessPathSchema,
  CreateBusinessRequestSchema,
  CreateBusinessResponseSchema,
  CurrentUserResponseSchema,
  EmptyQuerySchema,
  IdempotencyKeyHeaderSchema,
  MembersResponseSchema,
  MyBusinessesResponseSchema,
  PageQuerySchema,
  RegisterCurrentUserRequestSchema,
} from "./tenancy.js";

const ID = "0190a000-0000-7000-8000-000000000001";
const OTHER_ID = "0190a000-0000-7000-8000-000000000002";

describe("business currency response", () => {
  it("is exactly a currency code and an ISO 4217 minor-unit exponent", () => {
    for (const valid of [
      { code: "NGN", minorUnitDigits: 2 },
      { code: "JPY", minorUnitDigits: 0 },
      { code: "CLF", minorUnitDigits: 4 },
    ]) {
      expect(BusinessCurrencyResponseSchema.parse(valid)).toEqual(valid);
    }
    for (const invalid of [
      {},
      { code: "NGN" },
      { minorUnitDigits: 2 },
      { code: "ngn", minorUnitDigits: 2 },
      { code: "NGN", minorUnitDigits: -1 },
      { code: "NGN", minorUnitDigits: 5 },
      { code: "NGN", minorUnitDigits: 1.5 },
      { code: "NGN", minorUnitDigits: "2" },
      { code: "NGN", minorUnitDigits: 2, businessId: ID },
      { code: "NGN", minorUnitDigits: 2, symbol: "N" },
    ]) {
      expect(BusinessCurrencyResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("request contracts", () => {
  it("registration accepts a display name only", () => {
    expect(RegisterCurrentUserRequestSchema.parse({ displayName: "Amina" })).toEqual({ displayName: "Amina" });
    for (const body of [
      {},
      { displayName: 7 },
      { displayName: "x".repeat(401) },
      { displayName: "Amina", userId: ID },
      { displayName: "Amina", role: "OWNER" },
    ]) {
      expect(RegisterCurrentUserRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("business creation takes name, currency and time zone, and nothing a client could use to claim authority", () => {
    const valid = { name: "Duka", currencyCode: "KES", timeZone: "Africa/Nairobi" };
    expect(CreateBusinessRequestSchema.parse(valid)).toEqual(valid);
    for (const extra of [{ businessId: ID }, { ownerUserId: ID }, { status: "ACTIVE" }, { locationId: ID }]) {
      expect(CreateBusinessRequestSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
    expect(CreateBusinessRequestSchema.safeParse({ ...valid, name: "x".repeat(481) }).success).toBe(false);
    expect(CreateBusinessRequestSchema.safeParse({ ...valid, currencyCode: "kes" }).success).toBe(false);
    expect(CreateBusinessRequestSchema.safeParse({ ...valid, timeZone: "x".repeat(65) }).success).toBe(false);
    expect(CreateBusinessRequestSchema.safeParse({ ...valid, timeZone: "" }).success).toBe(false);
  });

  it("pagination accepts digit limits and bounded cursors only", () => {
    expect(PageQuerySchema.parse({})).toEqual({});
    expect(PageQuerySchema.parse({ limit: "25", after: "abc" })).toEqual({ limit: 25, after: "abc" });
    for (const query of [
      { limit: "-1" },
      { limit: "1.5" },
      { limit: "1e2" },
      { limit: "1000" },
      { limit: ["1", "2"] },
      { after: "" },
      { after: "x".repeat(257) },
      { offset: "10" },
    ]) {
      expect(PageQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("routes without query parameters reject any parameter", () => {
    expect(EmptyQuerySchema.safeParse({}).success).toBe(true);
    expect(EmptyQuerySchema.safeParse({ businessId: ID }).success).toBe(false);
  });

  it("the business path schema only extracts the claim; format checks belong to the resolver", () => {
    expect(BusinessPathSchema.parse({ businessId: "not-a-uuid" })).toEqual({ businessId: "not-a-uuid" });
  });

  it("bounds the raw idempotency key header", () => {
    expect(IdempotencyKeyHeaderSchema.safeParse(undefined).success).toBe(true);
    expect(IdempotencyKeyHeaderSchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("local sign-in accepts a bounded subject only", () => {
    expect(LocalSignInRequestSchema.parse({ subject: "local-user-amina" })).toEqual({ subject: "local-user-amina" });
    for (const body of [
      {},
      { subject: "" },
      { subject: "a".repeat(65) },
      { subject: "has space" },
      { subject: "-x" },
      { subject: "x", roles: ["OWNER"] },
      { subject: "x", sourceChannel: "system" },
    ]) {
      expect(LocalSignInRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("response contracts", () => {
  it("never carry provider subjects, versions, audit data or timestamps", () => {
    expect(CurrentUserResponseSchema.safeParse({ id: ID, displayName: "A", providerSubject: "s" }).success).toBe(false);
    expect(CurrentUserResponseSchema.safeParse({ id: ID, displayName: "A", status: "ACTIVE" }).success).toBe(false);
    const created = {
      business: { id: ID, name: "Duka", currencyCode: "KES", timeZone: "Africa/Nairobi" },
      defaultLocation: { id: OTHER_ID, name: "Main", isDefault: true, status: "ACTIVE" },
      membership: { id: ID, role: "OWNER", status: "ACTIVE" },
    };
    expect(CreateBusinessResponseSchema.safeParse(created).success).toBe(true);
    expect(
      CreateBusinessResponseSchema.safeParse({ ...created, membership: { ...created.membership, version: 1 } }).success,
    ).toBe(false);
    expect(
      CreateBusinessResponseSchema.safeParse({ ...created, business: { ...created.business, createdAt: "x" } }).success,
    ).toBe(false);
    expect(CreateBusinessResponseSchema.safeParse({ ...created, fingerprint: "00" }).success).toBe(false);
  });

  it("member listings expose the membership, display name, role and status only", () => {
    const item = { id: ID, displayName: "A", role: "CASHIER", status: "ACTIVE" };
    expect(MembersResponseSchema.safeParse({ items: [item], nextCursor: null }).success).toBe(true);
    expect(MembersResponseSchema.safeParse({ items: [{ ...item, userId: OTHER_ID }], nextCursor: null }).success).toBe(
      false,
    );
    expect(MembersResponseSchema.safeParse({ items: [{ ...item, role: "ADMIN" }], nextCursor: null }).success).toBe(
      false,
    );
  });

  it("my-businesses listings expose no membership status or version", () => {
    const business = { id: ID, name: "Duka", currencyCode: "KES", timeZone: "Africa/Nairobi" };
    const ok = { items: [{ business, membership: { id: OTHER_ID, role: "OWNER" } }], nextCursor: "c" };
    expect(MyBusinessesResponseSchema.safeParse(ok).success).toBe(true);
    expect(
      MyBusinessesResponseSchema.safeParse({
        items: [{ business, membership: { id: OTHER_ID, role: "OWNER", version: 2 } }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("local sign-in returns the token and its expiry only", () => {
    const body = { accessToken: "a.b.c", tokenType: "Bearer", expiresAt: "2026-09-29T09:00:00.000Z" };
    expect(LocalSignInResponseSchema.safeParse(body).success).toBe(true);
    expect(LocalSignInResponseSchema.safeParse({ ...body, refreshToken: "r" }).success).toBe(false);
    expect(LocalSignInResponseSchema.safeParse({ ...body, userId: ID }).success).toBe(false);
  });
});
