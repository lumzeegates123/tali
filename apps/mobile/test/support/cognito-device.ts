import { createHash, webcrypto } from "node:crypto";

/*
 * A simulated device for the mobile Cognito tests: SecureStore contents,
 * every SecureStore and AsyncStorage call, and a JavaScript stand-in for the
 * native SRP module of @aws-amplify/react-native. Held on globalThis so that
 * `jest.resetModules()` (a fresh JavaScript runtime, as after an app restart)
 * keeps the "device" while every module, Amplify included, starts again.
 */

export interface SecureCall {
  readonly op: "get" | "set" | "delete";
  readonly key: string;
  readonly options: unknown;
}

export interface AsyncStorageCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

export interface SimulatedDevice {
  readonly secure: Map<string, string>;
  readonly secureCalls: SecureCall[];
  readonly asyncStorageCalls: AsyncStorageCall[];
  /** Makes the next SecureStore write with this key prefix fail, to simulate an interrupted write. */
  failWritesFrom: { readonly prefix: string; afterWrites: number } | undefined;
}

const GLOBAL_KEY = "__taliSimulatedDevice";

export function device(): SimulatedDevice {
  const holder = globalThis as unknown as Record<string, SimulatedDevice | undefined>;
  holder[GLOBAL_KEY] ??= { secure: new Map(), secureCalls: [], asyncStorageCalls: [], failWritesFrom: undefined };
  return holder[GLOBAL_KEY];
}

export function resetDevice(): void {
  const state = device();
  state.secure.clear();
  state.secureCalls.length = 0;
  state.asyncStorageCalls.length = 0;
  state.failWritesFrom = undefined;
}

/** expo-secure-store over the simulated device. WHEN_UNLOCKED_THIS_DEVICE_ONLY is 6, as in the native module. */
export function secureStoreMock() {
  return {
    AFTER_FIRST_UNLOCK: 0,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
    ALWAYS: 2,
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 3,
    ALWAYS_THIS_DEVICE_ONLY: 4,
    WHEN_UNLOCKED: 5,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: (key: string, options: unknown) => {
      device().secureCalls.push({ op: "get", key, options });
      return Promise.resolve(device().secure.get(key) ?? null);
    },
    setItemAsync: (key: string, value: string, options: unknown) => {
      const state = device();
      state.secureCalls.push({ op: "set", key, options });
      const failure = state.failWritesFrom;
      if (failure !== undefined && key.startsWith(failure.prefix)) {
        if (failure.afterWrites <= 0) return Promise.reject(new Error("simulated interruption"));
        failure.afterWrites -= 1;
      }
      state.secure.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync: (key: string, options: unknown) => {
      device().secureCalls.push({ op: "delete", key, options });
      device().secure.delete(key);
      return Promise.resolve();
    },
  };
}

/** @react-native-async-storage/async-storage that records every call and stores nothing. */
export function asyncStorageMock() {
  const record =
    (op: string, result: unknown = null) =>
    (...args: unknown[]) => {
      device().asyncStorageCalls.push({ op, args });
      return Promise.resolve(result);
    };
  const api = {
    getItem: record("getItem"),
    setItem: record("setItem"),
    removeItem: record("removeItem"),
    mergeItem: record("mergeItem"),
    clear: record("clear"),
    getAllKeys: record("getAllKeys", []),
    multiGet: record("multiGet", []),
    multiSet: record("multiSet"),
    multiRemove: record("multiRemove"),
    multiMerge: record("multiMerge"),
    flushGetRequests: () => undefined,
  };
  return { __esModule: true, default: api, ...api };
}

export const ASYNC_STORAGE_WRITES = new Set([
  "setItem",
  "removeItem",
  "mergeItem",
  "clear",
  "multiSet",
  "multiRemove",
  "multiMerge",
]);

export function asyncStorageWrites(): AsyncStorageCall[] {
  return device().asyncStorageCalls.filter((call) => ASYNC_STORAGE_WRITES.has(call.op));
}

export function expoCryptoMock() {
  return {
    CryptoDigestAlgorithm: { SHA256: "SHA-256" },
    digestStringAsync: (_algorithm: string, value: string) =>
      Promise.resolve(createHash("sha256").update(value, "utf8").digest("hex")),
    getRandomValues: <T extends ArrayBufferView>(array: T): T => webcrypto.getRandomValues(array as never),
    randomUUID: () => webcrypto.randomUUID(),
  };
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/** Any odd modulus serves: the fake Cognito verifies nothing. The real module uses the RFC 5054 3072-bit group. */
const TEST_MODULUS = (1n << 521n) - 1n;

/**
 * A JavaScript stand-in for NativeModules.AmplifyRTNCore (Kotlin / Swift in
 * the app). It proves the wiring only; the native module itself is verified
 * on the reference device.
 */
export function installNativeSrpDouble(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NativeModules } = require("react-native") as { NativeModules: Record<string, unknown> };
  const hex = (value: string) => BigInt(`0x${value === "" ? "0" : value}`);
  NativeModules["AmplifyRTNCore"] = {
    computeModPow: ({ base, exponent, divisor }: { base: string; exponent: string; divisor: string }) =>
      Promise.resolve(modPow(hex(base), hex(exponent), hex(divisor)).toString(16)),
    computeS: (p: { a: string; g: string; k: string; x: string; b: string; u: string }) => {
      const n = TEST_MODULUS;
      const base = (((hex(p.b) - hex(p.k) * modPow(hex(p.g), hex(p.x), n)) % n) + n) % n;
      return Promise.resolve(modPow(base, hex(p.a) + hex(p.u) * hex(p.x), n).toString(16));
    },
    getDeviceName: () => Promise.resolve("Synthetic Test Device"),
  };
}
