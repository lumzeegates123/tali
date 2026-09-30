import type { BusinessId, Device, DeviceId } from "@tali/domain";
import type { SecretDigest } from "../../ports/one-time-secret.js";
import type { TransactionScope } from "../../ports/unit-of-work.js";
import type { Page, PageRequest } from "../../queries/pagination.js";

/**
 * Device registrations (tenant-owned; ADR-005 section 15). Every method takes
 * the business. The credential digest is written once and read back only for
 * verification, by (businessId, deviceId): never looked up by credential.
 */
export interface DeviceRepository {
  insert(scope: TransactionScope, device: Device, credentialDigest: SecretDigest): Promise<void>;
  /** The device of this business with its row locked until the transaction ends. */
  findByIdForUpdate(scope: TransactionScope, businessId: BusinessId, deviceId: DeviceId): Promise<Device | undefined>;
  /** The device of this business and its stored credential digest, for verification only. */
  findForVerification(
    scope: TransactionScope,
    businessId: BusinessId,
    deviceId: DeviceId,
  ): Promise<{ readonly device: Device; readonly credentialDigest: SecretDigest } | undefined>;
  /**
   * Persists a transition of `previous` to `next` (same ID and business).
   * Throws ConcurrentModificationError when the stored status is no longer
   * `previous.status`.
   */
  update(scope: TransactionScope, previous: Device, next: Device): Promise<void>;
  /** ACTIVE and REVOKED devices of the business, ordered by device ID. */
  list(scope: TransactionScope, businessId: BusinessId, page: PageRequest): Promise<Page<Device>>;
}

/** Precondition of DeviceRepository.update, shared by every adapter. */
export function assertDeviceTransition(previous: Device, next: Device): void {
  if (
    next.id !== previous.id ||
    next.businessId !== previous.businessId ||
    next.label !== previous.label ||
    next.registeredByMembershipId !== previous.registeredByMembershipId ||
    next.registeredAt.getTime() !== previous.registeredAt.getTime() ||
    previous.status !== "ACTIVE" ||
    next.status !== "REVOKED"
  ) {
    throw new Error("a device update must keep its identity and go from ACTIVE to REVOKED");
  }
}
