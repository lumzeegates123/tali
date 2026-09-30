import * as SecureStore from "expo-secure-store";

/** A device registration for one business: the server-issued device ID and its one-time credential. */
export interface DeviceRegistration {
  readonly deviceId: string;
  readonly credential: string;
}

/**
 * Per-business storage of device registrations (plan 003 section 7). The
 * device credential is the only client secret Tali keeps across app
 * restarts, so it lives in the platform keystore only, one entry per
 * business, and holds nothing but the device ID and credential. Signing out
 * keeps the entries: a registration belongs to the device and the business,
 * not to the user, and every request still needs normal sign-in.
 */
export interface DeviceCredentialStore {
  read(businessId: string): Promise<DeviceRegistration | undefined>;
  save(businessId: string, registration: DeviceRegistration): Promise<void>;
  clear(businessId: string): Promise<void>;
}

/** The part of expo-secure-store this module uses, so tests can substitute it. */
export interface SecureStoreModule {
  getItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CREDENTIAL = /^[A-Za-z0-9_-]{1,128}$/u;
const KEY_PREFIX = "tali.device.v1.";

/** Keystore entries are never synced to other devices and are only readable while the device is unlocked. */
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** The keystore key for a business; the business ID must be a canonical lowercase UUID. */
export function deviceRegistrationKey(businessId: string): string {
  if (!UUID.test(businessId)) throw new Error("A device registration needs a business ID");
  return `${KEY_PREFIX}${businessId}`;
}

function parse(raw: string | null): DeviceRegistration | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const { deviceId, credential } = value as Record<string, unknown>;
    if (typeof deviceId !== "string" || !UUID.test(deviceId)) return undefined;
    if (typeof credential !== "string" || !CREDENTIAL.test(credential)) return undefined;
    return { deviceId, credential };
  } catch {
    return undefined;
  }
}

export function createSecureDeviceCredentialStore(secureStore: SecureStoreModule = SecureStore): DeviceCredentialStore {
  return {
    async read(businessId) {
      return parse(await secureStore.getItemAsync(deviceRegistrationKey(businessId), OPTIONS));
    },
    async save(businessId, registration) {
      await secureStore.setItemAsync(
        deviceRegistrationKey(businessId),
        JSON.stringify({ deviceId: registration.deviceId, credential: registration.credential }),
        OPTIONS,
      );
    },
    async clear(businessId) {
      await secureStore.deleteItemAsync(deviceRegistrationKey(businessId), OPTIONS);
    },
  };
}

/** For platforms where device registration is not offered (iOS in Build 1): nothing is read or written. */
export const noDeviceCredentialStore: DeviceCredentialStore = {
  read: () => Promise.resolve(undefined),
  save: () => Promise.reject(new Error("Device registration is not available on this platform")),
  clear: () => Promise.resolve(),
};
