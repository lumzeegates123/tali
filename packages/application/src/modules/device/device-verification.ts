import type { DeviceId } from "@tali/domain";
import { isDeviceActive, parseDeviceId } from "@tali/domain";
import type { BusinessContext } from "../../context/business-context.js";
import { DeviceNotTrustedError } from "../../errors/application-error.js";
import type { SecretDigest, SecretHasher } from "../../ports/one-time-secret.js";
import { ONE_TIME_SECRET_RANDOM_BYTES, parseOneTimeSecret } from "../../ports/one-time-secret.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { DeviceRepository } from "./ports.js";

/** The raw device header values of one request; undefined when a header is absent. */
export interface PresentedDevice {
  readonly deviceId: string | undefined;
  readonly credential: string | undefined;
}

/**
 * Optional device verification for business-scoped requests (ADR-005 section
 * 15.3, context resolution step 8). Runs after the user and the business
 * context were resolved: a device never authenticates a user and never adds
 * permissions.
 *
 * - Neither value: the context is returned unchanged, without a device.
 * - Both values: the device is loaded by (context business, device ID), the
 *   credential's digest is compared in constant time, and only an ACTIVE
 *   match sets `deviceId`.
 * - Anything else fails closed with one DEVICE_NOT_TRUSTED: one value
 *   missing, a malformed value, an unknown or foreign device, a mismatch or a
 *   REVOKED device. The request is never downgraded to "no device".
 */
export interface DeviceVerifier {
  verify(context: BusinessContext, presented: PresentedDevice): Promise<BusinessContext>;
}

export function createDeviceVerifier(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly devices: DeviceRepository;
  readonly secretHasher: SecretHasher;
}): DeviceVerifier {
  // Compared against when the device is unknown, so both outcomes do the same work.
  const placeholder = new Uint8Array(ONE_TIME_SECRET_RANDOM_BYTES) as SecretDigest;
  return {
    async verify(context, presented) {
      if (presented.deviceId === undefined && presented.credential === undefined) return context;
      if (presented.deviceId === undefined || presented.credential === undefined) throw new DeviceNotTrustedError();
      let deviceId: DeviceId;
      try {
        deviceId = parseDeviceId(presented.deviceId);
      } catch {
        throw new DeviceNotTrustedError();
      }
      const credential = parseOneTimeSecret("device", presented.credential);
      if (credential === undefined) throw new DeviceNotTrustedError();

      const found = await dependencies.unitOfWork.run((scope) =>
        dependencies.devices.findForVerification(scope, context.businessId, deviceId),
      );
      const matches = dependencies.secretHasher.matches(credential, found?.credentialDigest ?? placeholder);
      if (found === undefined || !matches || !isDeviceActive(found.device)) throw new DeviceNotTrustedError();
      return Object.freeze({ ...context, deviceId: found.device.id });
    },
  };
}
