import { z } from "zod";
import { CurrencyCodeWireSchema } from "./money.js";

/**
 * Build 1 identity and tenancy wire contracts (plan 003 section 5, ADR-005).
 * Every object is strict: unknown fields are rejected on input and can never
 * appear on output. Length bounds here are transport limits only; the exact
 * rules (trimming, NFC, code-point lengths, supported currencies, canonical
 * time zones) are enforced server-side by the domain.
 *
 * Responses never carry provider subjects, membership versions, audit data,
 * fingerprints, timestamps or other storage fields.
 */

const IdWireSchema = z.uuid();

export const MembershipRoleWireSchema = z.enum(["OWNER", "MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"]);
export const MembershipStatusWireSchema = z.enum(["ACTIVE", "SUSPENDED"]);
export const LocationStatusWireSchema = z.enum(["ACTIVE", "ARCHIVED"]);

// ---- Requests ------------------------------------------------------------

/** For routes that take no query parameters: any parameter is rejected. */
export const EmptyQuerySchema = z.strictObject({});

/** Keyset pagination: `limit` (1 to 100, default 50, checked server-side) and an opaque `after` cursor. */
export const PageQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/, "must be an integer")
    .transform((value) => Number.parseInt(value, 10))
    .optional(),
  after: z.string().min(1).max(256).optional(),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

/**
 * Path of every business-scoped route. The value is a claim, never a fact: a
 * malformed or inaccessible ID is answered with NOT_FOUND, never a validation
 * error (ADR-005 section 12), so this schema only extracts it.
 */
export const BusinessPathSchema = z.strictObject({ businessId: z.string() });

/** The raw `Idempotency-Key` header; its RFC 9562 UUID format is checked server-side. */
export const IdempotencyKeyHeaderSchema = z.string().max(128).optional();

/** `POST /v1/me/registration`. */
export const RegisterCurrentUserRequestSchema = z.strictObject({
  displayName: z.string().max(400),
});

export type RegisterCurrentUserRequest = z.infer<typeof RegisterCurrentUserRequestSchema>;

/** `POST /v1/businesses` (requires `Idempotency-Key`). */
export const CreateBusinessRequestSchema = z.strictObject({
  name: z.string().max(480),
  currencyCode: CurrencyCodeWireSchema,
  timeZone: z.string().min(1).max(64),
});

export type CreateBusinessRequest = z.infer<typeof CreateBusinessRequestSchema>;

// ---- Responses -----------------------------------------------------------

/** `GET /v1/me`, `POST /v1/me/registration`. */
export const CurrentUserResponseSchema = z.strictObject({
  id: IdWireSchema,
  displayName: z.string(),
});

export type CurrentUserResponse = z.infer<typeof CurrentUserResponseSchema>;

/** `GET /v1/businesses/:businessId`. */
export const BusinessResponseSchema = z.strictObject({
  id: IdWireSchema,
  name: z.string(),
  currencyCode: CurrencyCodeWireSchema,
  timeZone: z.string(),
});

export type BusinessResponse = z.infer<typeof BusinessResponseSchema>;

export const LocationResponseSchema = z.strictObject({
  id: IdWireSchema,
  name: z.string(),
  isDefault: z.boolean(),
  status: LocationStatusWireSchema,
});

export type LocationResponse = z.infer<typeof LocationResponseSchema>;

/** `POST /v1/businesses` (201, and on replay with `Idempotent-Replayed: true`). */
export const CreateBusinessResponseSchema = z.strictObject({
  business: BusinessResponseSchema,
  defaultLocation: LocationResponseSchema,
  membership: z.strictObject({
    id: IdWireSchema,
    role: MembershipRoleWireSchema,
    status: MembershipStatusWireSchema,
  }),
});

export type CreateBusinessResponse = z.infer<typeof CreateBusinessResponseSchema>;

const nextCursor = z.string().min(1).max(256).nullable();

/** `GET /v1/me/businesses`. */
export const MyBusinessesResponseSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      business: BusinessResponseSchema,
      membership: z.strictObject({ id: IdWireSchema, role: MembershipRoleWireSchema }),
    }),
  ),
  nextCursor,
});

export type MyBusinessesResponse = z.infer<typeof MyBusinessesResponseSchema>;

/** `GET /v1/businesses/:businessId/locations`. */
export const LocationsResponseSchema = z.strictObject({
  items: z.array(LocationResponseSchema),
  nextCursor,
});

export type LocationsResponse = z.infer<typeof LocationsResponseSchema>;

/** `GET /v1/businesses/:businessId/members` (`member:read`). The item ID is the membership ID. */
export const MembersResponseSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: IdWireSchema,
      displayName: z.string(),
      role: MembershipRoleWireSchema,
      status: MembershipStatusWireSchema,
    }),
  ),
  nextCursor,
});

export type MembersResponse = z.infer<typeof MembersResponseSchema>;
