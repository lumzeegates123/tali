import { z } from "zod";
import { BusinessResponseSchema, MembershipRoleWireSchema, MembershipStatusWireSchema } from "./tenancy.js";

/**
 * Build 1 slice 5 wire contracts: business rename, invitations, member
 * management and devices (plan 003 sections 5 and 6, ADR-005 sections 9, 14
 * and 15). Every object is strict. Length bounds are transport limits only;
 * the exact rules are enforced server-side by the domain.
 *
 * One-time secrets (invitation tokens, device credentials) appear only in the
 * first response of their create operation, next to `tokenAvailable: true` or
 * `credentialAvailable: true`. A replay carries the `false` flag and no
 * secret. Their printable format is a server concern and is deliberately not
 * described here, so no client bundle contains it.
 */

const IdWireSchema = z.uuid();
const nextCursor = z.string().min(1).max(256).nullable();
const OneTimeSecretWireSchema = z.string().min(1).max(128);

export const InvitableRoleWireSchema = z.enum(["MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"]);
export const InvitationStatusWireSchema = z.enum(["PENDING", "ACCEPTED", "REVOKED"]);
export const DevicePlatformWireSchema = z.enum(["ANDROID"]);
export const DeviceStatusWireSchema = z.enum(["ACTIVE", "REVOKED"]);

// ---- Paths ---------------------------------------------------------------
// Values are claims: a malformed or foreign ID is answered with NOT_FOUND.

export const InvitationPathSchema = z.strictObject({ businessId: z.string(), invitationId: z.string() });
export const MemberPathSchema = z.strictObject({ businessId: z.string(), membershipId: z.string() });
export const DevicePathSchema = z.strictObject({ businessId: z.string(), deviceId: z.string() });

// ---- Requests ------------------------------------------------------------

/** `PATCH /v1/businesses/:businessId` (`business:update`): the name only. */
export const UpdateBusinessNameRequestSchema = z.strictObject({ name: z.string().max(480) });
export type UpdateBusinessNameRequest = z.infer<typeof UpdateBusinessNameRequestSchema>;

/** `POST /v1/businesses/:businessId/invitations` (`member:invite`, requires `Idempotency-Key`). */
export const CreateInvitationRequestSchema = z.strictObject({ role: InvitableRoleWireSchema });
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;

/** `POST /v1/invitations/accept`: the token travels only in this body, never in a URL. */
export const AcceptInvitationRequestSchema = z.strictObject({ token: z.string().min(1).max(256) });
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequestSchema>;

const ReasonWireSchema = z.string().max(2000);

/** `POST /v1/businesses/:businessId/members/:membershipId/role` (`member:manage`). */
export const ChangeMemberRoleRequestSchema = z.strictObject({
  role: MembershipRoleWireSchema,
  reason: ReasonWireSchema,
});
export type ChangeMemberRoleRequest = z.infer<typeof ChangeMemberRoleRequestSchema>;

/** `POST .../members/:membershipId/suspend` and `.../reactivate` (`member:manage`). */
export const MemberStatusChangeRequestSchema = z.strictObject({ reason: ReasonWireSchema });
export type MemberStatusChangeRequest = z.infer<typeof MemberStatusChangeRequestSchema>;

/** `POST /v1/businesses/:businessId/devices` (`device:register`, requires `Idempotency-Key`). */
export const RegisterDeviceRequestSchema = z.strictObject({
  platform: DevicePlatformWireSchema,
  label: z.string().max(240),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

/** Routes with no body: any field is rejected. */
export const EmptyBodySchema = z.strictObject({});

// ---- Responses -----------------------------------------------------------

export const InvitationResponseSchema = z.strictObject({
  id: IdWireSchema,
  role: InvitableRoleWireSchema,
  status: InvitationStatusWireSchema,
  expiresAt: z.iso.datetime(),
});
export type InvitationResponse = z.infer<typeof InvitationResponseSchema>;

/** `POST .../invitations` (201; a replay is 201 with `Idempotent-Replayed: true` and no token). */
export const CreateInvitationResponseSchema = z.discriminatedUnion("tokenAvailable", [
  z.strictObject({
    invitation: InvitationResponseSchema,
    tokenAvailable: z.literal(true),
    token: OneTimeSecretWireSchema,
  }),
  z.strictObject({ invitation: InvitationResponseSchema, tokenAvailable: z.literal(false) }),
]);
export type CreateInvitationResponse = z.infer<typeof CreateInvitationResponseSchema>;

/** `POST .../invitations/:invitationId/revoke` (200; revoking a REVOKED invitation is a no-op). */
export const RevokeInvitationResponseSchema = z.strictObject({ invitation: InvitationResponseSchema });
export type RevokeInvitationResponse = z.infer<typeof RevokeInvitationResponseSchema>;

const MembershipSummarySchema = z.strictObject({
  id: IdWireSchema,
  role: MembershipRoleWireSchema,
  status: MembershipStatusWireSchema,
});

/** `POST /v1/invitations/accept` (200, also for a replay by the same user). */
export const AcceptInvitationResponseSchema = z.strictObject({
  business: BusinessResponseSchema,
  membership: MembershipSummarySchema,
});
export type AcceptInvitationResponse = z.infer<typeof AcceptInvitationResponseSchema>;

/** Member role and status changes (200; a change to the current state is a no-op). */
export const MemberChangeResponseSchema = z.strictObject({ membership: MembershipSummarySchema });
export type MemberChangeResponse = z.infer<typeof MemberChangeResponseSchema>;

/** Safe device metadata only: never a credential or its digest. */
export const DeviceResponseSchema = z.strictObject({
  id: IdWireSchema,
  platform: DevicePlatformWireSchema,
  label: z.string(),
  status: DeviceStatusWireSchema,
});
export type DeviceResponse = z.infer<typeof DeviceResponseSchema>;

/** `POST .../devices` (201; a replay is 201 with `Idempotent-Replayed: true` and no credential). */
export const RegisterDeviceResponseSchema = z.discriminatedUnion("credentialAvailable", [
  z.strictObject({
    device: DeviceResponseSchema,
    credentialAvailable: z.literal(true),
    credential: OneTimeSecretWireSchema,
  }),
  z.strictObject({ device: DeviceResponseSchema, credentialAvailable: z.literal(false) }),
]);
export type RegisterDeviceResponse = z.infer<typeof RegisterDeviceResponseSchema>;

/** `GET .../devices` (`device:read`), keyset page. */
export const DevicesResponseSchema = z.strictObject({ items: z.array(DeviceResponseSchema), nextCursor });
export type DevicesResponse = z.infer<typeof DevicesResponseSchema>;

/** `POST .../devices/:deviceId/revoke` (`device:revoke`; revoking a REVOKED device is a no-op). */
export const RevokeDeviceResponseSchema = z.strictObject({ device: DeviceResponseSchema });
export type RevokeDeviceResponse = z.infer<typeof RevokeDeviceResponseSchema>;

/** The optional device headers on business-scoped requests (ADR-005 section 15.3). */
export const DEVICE_ID_HEADER = "X-Tali-Device-Id";
export const DEVICE_CREDENTIAL_HEADER = "X-Tali-Device-Credential";
