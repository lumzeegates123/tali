import { DomainError } from "../../errors.js";
import type { Id } from "../../kernel/index.js";
import { parseId } from "../../kernel/index.js";
import { normalizeBoundedName } from "../../text.js";
import type { BusinessId, MembershipId } from "../business/index.js";

export type DeviceId = Id<"Device">;

export function parseDeviceId(value: string): DeviceId {
  return parseId("Device", value);
}

/** The approved platform vocabulary (ADR-005 section 15.1). iOS is added later by migration. */
export const DEVICE_PLATFORMS = ["ANDROID"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const DEVICE_STATUSES = ["ACTIVE", "REVOKED"] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

declare const deviceLabelBrand: unique symbol;

/** 1 to 60 characters after trimming and NFC normalization. A human hint, never an identity. */
export type DeviceLabel = string & { readonly [deviceLabelBrand]: true };

export const DEVICE_LABEL_MAX_LENGTH = 60;

export function parseDeviceLabel(value: string): DeviceLabel {
  return normalizeBoundedName(value, "label", DEVICE_LABEL_MAX_LENGTH) as DeviceLabel;
}

export function parseDevicePlatform(value: string): DevicePlatform {
  if (!(DEVICE_PLATFORMS as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "platform is not supported", "platform");
  }
  return value as DevicePlatform;
}

/**
 * A device registration in one business (ADR-005 section 15). It is
 * supplemental business-scoped trust, never a user credential, and not bound
 * to a user. The credential is not part of the entity: only the storage
 * adapter holds its digest.
 */
export interface Device {
  readonly id: DeviceId;
  readonly businessId: BusinessId;
  readonly platform: DevicePlatform;
  readonly label: DeviceLabel;
  readonly status: DeviceStatus;
  readonly registeredByMembershipId: MembershipId;
  readonly registeredAt: Date;
  readonly revokedByMembershipId?: MembershipId;
  readonly revokedAt?: Date;
}

function validInstant(value: Date, field: string): Date {
  if (Number.isNaN(value.getTime())) {
    throw new DomainError("INVALID_VALUE", `${field} must be a valid instant`, field);
  }
  return new Date(value.getTime());
}

export function registerDevice(props: {
  readonly id: DeviceId;
  readonly businessId: BusinessId;
  readonly platform: DevicePlatform;
  readonly label: DeviceLabel;
  readonly registeredByMembershipId: MembershipId;
  readonly now: Date;
}): Device {
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    platform: parseDevicePlatform(props.platform),
    label: parseDeviceLabel(props.label),
    status: "ACTIVE",
    registeredByMembershipId: props.registeredByMembershipId,
    registeredAt: validInstant(props.now, "now"),
  });
}

/** Validates a device read from storage; the revocation columns must agree with the status. */
export function restoreDevice(props: {
  readonly id: DeviceId;
  readonly businessId: BusinessId;
  readonly platform: string;
  readonly label: string;
  readonly status: string;
  readonly registeredByMembershipId: MembershipId;
  readonly registeredAt: Date;
  readonly revokedByMembershipId?: MembershipId | undefined;
  readonly revokedAt?: Date | undefined;
}): Device {
  if (!(DEVICE_STATUSES as readonly string[]).includes(props.status)) {
    throw new DomainError("INVALID_VALUE", "unknown device status", "status");
  }
  const status = props.status as DeviceStatus;
  const revoked = props.revokedByMembershipId !== undefined && props.revokedAt !== undefined;
  const notRevoked = props.revokedByMembershipId === undefined && props.revokedAt === undefined;
  if (!((status === "ACTIVE" && notRevoked) || (status === "REVOKED" && revoked))) {
    throw new DomainError("INVALID_VALUE", "device revocation columns do not match its status", "status");
  }
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    platform: parseDevicePlatform(props.platform),
    label: parseDeviceLabel(props.label),
    status,
    registeredByMembershipId: props.registeredByMembershipId,
    registeredAt: validInstant(props.registeredAt, "registeredAt"),
    ...(props.revokedByMembershipId === undefined ? {} : { revokedByMembershipId: props.revokedByMembershipId }),
    ...(props.revokedAt === undefined ? {} : { revokedAt: validInstant(props.revokedAt, "revokedAt") }),
  });
}

export function isDeviceActive(device: Device): boolean {
  return device.status === "ACTIVE";
}

export type DeviceTransition =
  | { readonly outcome: "unchanged"; readonly device: Device }
  | { readonly outcome: "changed"; readonly device: Device; readonly previous: Device };

/** ACTIVE to REVOKED. Already REVOKED is a no-op (ADR-004 section 7). There is no reactivation. */
export function revokeDevice(props: {
  readonly device: Device;
  readonly revokedByMembershipId: MembershipId;
  readonly now: Date;
}): DeviceTransition {
  const { device } = props;
  if (device.status === "REVOKED") return { outcome: "unchanged", device };
  return {
    outcome: "changed",
    previous: device,
    device: Object.freeze({
      ...device,
      status: "REVOKED",
      revokedByMembershipId: props.revokedByMembershipId,
      revokedAt: validInstant(props.now, "now"),
    }),
  };
}
