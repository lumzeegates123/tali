import type { DeviceRepository, SecretDigest } from "@tali/application";
import { assertDeviceTransition, ConcurrentModificationError } from "@tali/application";
import type { Device } from "@tali/domain";
import { parseBusinessId, parseDeviceId, parseMembershipId, restoreDevice } from "@tali/domain";
import type { Device as DeviceRow } from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { keysetArgs, toPage } from "./pagination.js";

/** The row without its credential digest; only findForVerification reads the digest. */
type DeviceFields = Omit<DeviceRow, "credentialHash">;

const DEVICE_FIELDS = {
  businessId: true,
  id: true,
  platform: true,
  label: true,
  status: true,
  registeredByMembershipId: true,
  registeredAt: true,
  revokedByMembershipId: true,
  revokedAt: true,
} as const;

function toDevice(row: DeviceFields): Device {
  return restoreDevice({
    id: parseDeviceId(row.id),
    businessId: parseBusinessId(row.businessId),
    platform: row.platform,
    label: row.label,
    status: row.status,
    registeredByMembershipId: parseMembershipId(row.registeredByMembershipId),
    registeredAt: row.registeredAt,
    revokedByMembershipId:
      row.revokedByMembershipId === null ? undefined : parseMembershipId(row.revokedByMembershipId),
    revokedAt: row.revokedAt ?? undefined,
  });
}

/**
 * Device registrations (tenant-owned; ADR-005 section 15). Every lookup is by
 * (business_id, id); a device is never found by its credential.
 */
export function createDeviceRepository(): DeviceRepository {
  return {
    async insert(scope, device, credentialDigest) {
      await transactionClient(scope).device.create({
        data: {
          businessId: device.businessId,
          id: device.id,
          platform: device.platform,
          label: device.label,
          credentialHash: new Uint8Array(credentialDigest),
          status: device.status,
          registeredByMembershipId: device.registeredByMembershipId,
          registeredAt: device.registeredAt,
        },
      });
    },

    async findByIdForUpdate(scope, businessId, deviceId) {
      const client = transactionClient(scope);
      const locked = await client.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM devices WHERE business_id = ${businessId}::uuid AND id = ${deviceId}::uuid FOR UPDATE`;
      if (locked.length !== 1) return undefined;
      const row = await client.device.findUnique({
        where: { businessId_id: { businessId, id: deviceId } },
        select: DEVICE_FIELDS,
      });
      return row === null ? undefined : toDevice(row);
    },

    async findForVerification(scope, businessId, deviceId) {
      const row = await transactionClient(scope).device.findUnique({
        where: { businessId_id: { businessId, id: deviceId } },
      });
      if (row === null) return undefined;
      return { device: toDevice(row), credentialDigest: new Uint8Array(row.credentialHash) as SecretDigest };
    },

    async update(scope, previous, next) {
      assertDeviceTransition(previous, next);
      const { count } = await transactionClient(scope).device.updateMany({
        where: { businessId: previous.businessId, id: previous.id, status: previous.status },
        data: {
          status: next.status,
          revokedByMembershipId: next.revokedByMembershipId ?? null,
          revokedAt: next.revokedAt ?? null,
        },
      });
      if (count !== 1) throw new ConcurrentModificationError();
    },

    async list(scope, businessId, request) {
      const page = keysetArgs(request);
      const rows = await transactionClient(scope).device.findMany({
        where: { businessId, ...page.where },
        orderBy: page.orderBy,
        take: page.take,
        select: DEVICE_FIELDS,
      });
      return toPage(rows, request, (row) => row.id, toDevice);
    },
  };
}
