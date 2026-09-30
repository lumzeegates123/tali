import type { Device, DeviceId } from "@tali/domain";
import {
  parseBusinessId,
  parseDeviceId,
  parseDeviceLabel,
  parseDevicePlatform,
  parseMembershipId,
  registerDevice,
  restoreDevice,
  revokeDevice,
} from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { BusinessContext } from "../../context/business-context.js";
import { NotFoundError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import { idempotencyActorOf } from "../../idempotency/business-idempotency-store.js";
import { canonicalCommandEncoding } from "../../idempotency/canonical-command.js";
import type { FingerprintHasher } from "../../idempotency/fingerprint-hasher.js";
import { requireIdempotencyKey } from "../../idempotency/idempotency-key.js";
import type { IdempotentResultCodec, KeyedIdempotency } from "../../idempotency/keyed-idempotency.js";
import { instantAt, objectAt, optionalTextAt, textAt } from "../../idempotency/result-json.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { OneTimeSecret, OneTimeSecretGenerator, SecretHasher } from "../../ports/one-time-secret.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { Page } from "../../queries/pagination.js";
import { parsePageRequest } from "../../queries/pagination.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership, requireUserActor } from "../business/index.js";
import { identityPermissions } from "../identity/index.js";
import { deviceRegistered, deviceRevoked } from "./audit-actions.js";
import type { DeviceRepository } from "./ports.js";

export const REGISTER_DEVICE_OPERATION = "device.register.v1";
export const REGISTER_DEVICE_COMMAND_SCHEMA_VERSION = 1;

const DEVICE_NOT_FOUND = "Device not found";

/**
 * The original response carries the plaintext credential once; a replay
 * never does (ADR-004 section 12). Recovery is revoke and register again.
 */
export type RegisterDeviceOutcome =
  | { readonly device: Device; readonly replayed: false; readonly credential: OneTimeSecret }
  | { readonly device: Device; readonly replayed: true };

/**
 * `device:register` (every active role; ADR-005 section 15.2). The server
 * generates the device ID (UUIDv7) and the credential; the device is
 * registered by the acting membership and is not bound to a user.
 */
export interface RegisterDevice {
  execute(
    context: BusinessContext,
    input: { readonly platform: string; readonly label: string; readonly idempotencyKey: string | undefined },
  ): Promise<RegisterDeviceOutcome>;
}

/** `device:read` (OWNER, MANAGER): safe metadata of the business's devices. */
export interface ListDevices {
  execute(context: BusinessContext, page?: { readonly limit?: number; readonly after?: string }): Promise<Page<Device>>;
}

export interface DeviceChangeResult {
  readonly device: Device;
  /** False for the successful no-op of revoking a REVOKED device (no audit record). */
  readonly changed: boolean;
}

/** `device:revoke` (OWNER): ACTIVE to REVOKED; later requests with its credential are DEVICE_NOT_TRUSTED. */
export interface RevokeDevice {
  execute(context: BusinessContext, input: { readonly deviceId: string }): Promise<DeviceChangeResult>;
}

/** Stores the device metadata only; the credential is never part of the stored result. */
export const deviceResultCodec: IdempotentResultCodec<Device> = {
  encode(device) {
    return {
      device: {
        id: device.id,
        businessId: device.businessId,
        platform: device.platform,
        label: device.label,
        status: device.status,
        registeredByMembershipId: device.registeredByMembershipId,
        registeredAt: device.registeredAt.toISOString(),
      },
    };
  },
  decode(stored) {
    const d = objectAt(objectAt(stored, "result")["device"], "device");
    if (optionalTextAt(d, "revokedAt") !== undefined)
      throw new Error("stored device result has unexpected state fields");
    return restoreDevice({
      id: parseDeviceId(textAt(d, "id")),
      businessId: parseBusinessId(textAt(d, "businessId")),
      platform: textAt(d, "platform"),
      label: textAt(d, "label"),
      status: textAt(d, "status"),
      registeredByMembershipId: parseMembershipId(textAt(d, "registeredByMembershipId")),
      registeredAt: instantAt(d, "registeredAt"),
    });
  },
};

export function createRegisterDevice(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly devices: DeviceRepository;
  readonly idempotency: KeyedIdempotency;
  readonly hasher: FingerprintHasher;
  readonly secrets: OneTimeSecretGenerator;
  readonly secretHasher: SecretHasher;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}): RegisterDevice {
  const permission = identityPermissions.permissions["device:register"];
  return {
    async execute(context, input) {
      const actor = requireUserActor(context, permission);
      const key = requireIdempotencyKey(input.idempotencyKey);
      const platform = withDomainRules(() => parseDevicePlatform(input.platform), "platform");
      const label = withDomainRules(() => parseDeviceLabel(input.label), "label");
      const command = canonicalCommandEncoding({
        operation: REGISTER_DEVICE_OPERATION,
        commandSchemaVersion: REGISTER_DEVICE_COMMAND_SCHEMA_VERSION,
        command: { platform, label },
      });
      const fingerprint = await dependencies.hasher.fingerprint(command);

      return dependencies.unitOfWork.run(async (scope): Promise<RegisterDeviceOutcome> => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        let credential: OneTimeSecret | undefined;
        const outcome = await dependencies.idempotency.runBusinessScoped(scope, {
          businessId: context.businessId,
          actor: idempotencyActorOf(actor),
          key,
          command,
          fingerprint,
          resourceType: "device",
          codec: deviceResultCodec,
          plan: async () => {
            const device = registerDevice({
              id: dependencies.ids.newId("Device"),
              businessId: context.businessId,
              platform,
              label,
              registeredByMembershipId: actor.membershipId,
              now: dependencies.clock.now(),
            });
            const secret = dependencies.secrets.generate("device");
            const credentialDigest = dependencies.secretHasher.digest(secret);
            return {
              result: device,
              resourceId: device.id,
              apply: async () => {
                await dependencies.devices.insert(scope, device, credentialDigest);
                await dependencies.audit.recordBusinessEvent(scope, deviceRegistered, {
                  ...businessAuditEnvelope(context, key),
                  entityId: device.id,
                  payload: {
                    platform: device.platform,
                    status: device.status,
                    registeredByMembershipId: device.registeredByMembershipId,
                  },
                });
                credential = secret;
              },
            };
          },
        });
        if (outcome.replayed) return { device: outcome.result, replayed: true };
        if (credential === undefined) throw new Error("a new device was registered without its credential");
        return { device: outcome.result, replayed: false, credential };
      });
    },
  };
}

export function createListDevices(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly devices: DeviceRepository;
}): ListDevices {
  return {
    async execute(context, page) {
      requireUserActor(context, identityPermissions.permissions["device:read"]);
      const request = parsePageRequest(page);
      return dependencies.unitOfWork.run((scope) => dependencies.devices.list(scope, context.businessId, request));
    },
  };
}

function parseDevice(value: string): DeviceId {
  try {
    return parseDeviceId(value);
  } catch {
    throw new NotFoundError(DEVICE_NOT_FOUND);
  }
}

export function createRevokeDevice(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly devices: DeviceRepository;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
}): RevokeDevice {
  const permission = identityPermissions.permissions["device:revoke"];
  return {
    async execute(context, input) {
      requireUserActor(context, permission);
      const deviceId = parseDevice(input.deviceId);
      return dependencies.unitOfWork.run(async (scope) => {
        const actor = await requireActingMembership(scope, dependencies.memberships, context, permission);
        const device = await dependencies.devices.findByIdForUpdate(scope, context.businessId, deviceId);
        if (device === undefined) throw new NotFoundError(DEVICE_NOT_FOUND);
        const transition = revokeDevice({ device, revokedByMembershipId: actor.id, now: dependencies.clock.now() });
        if (transition.outcome === "unchanged") return { device, changed: false };
        await dependencies.devices.update(scope, transition.previous, transition.device);
        await dependencies.audit.recordBusinessEvent(scope, deviceRevoked, {
          ...businessAuditEnvelope(context),
          entityId: device.id,
          payload: { platform: device.platform, status: transition.device.status },
        });
        return { device: transition.device, changed: true };
      });
    },
  };
}
