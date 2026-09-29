import { getRandomValues } from "expo-crypto";

export type SecureRandomSource = "platform" | "expo-crypto";

interface CryptoHost {
  crypto?: Partial<Crypto>;
}

type IntegerTypedArray =
  Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array;

const INTEGER_ARRAY_TYPES = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
];

const installed = new WeakSet<object>();

function isIntegerTypedArray(value: unknown): value is IntegerTypedArray {
  return INTEGER_ARRAY_TYPES.some((type) => value instanceof type);
}

/**
 * uuid@14 (the `default` export condition Metro resolves) reads the global
 * `crypto.getRandomValues`. Hermes does not provide Web Crypto, so this
 * installs `expo-crypto`'s native CSPRNG (Android SecureRandom) under that
 * name when, and only when, the runtime has none. It never installs a
 * non-cryptographic source. Idempotent; reports which source is in use.
 */
export function installSecureRandom(host: CryptoHost = globalThis): SecureRandomSource {
  const existing = host.crypto?.getRandomValues;
  if (typeof existing === "function") return installed.has(existing) ? "expo-crypto" : "platform";
  const secureGetRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (!isIntegerTypedArray(array)) throw new TypeError("getRandomValues requires an integer typed array");
    getRandomValues(array);
    return array;
  };
  installed.add(secureGetRandomValues);
  const target: Partial<Crypto> = host.crypto ?? {};
  Object.defineProperty(target, "getRandomValues", {
    configurable: true,
    writable: true,
    value: secureGetRandomValues,
  });
  if (host.crypto === undefined) {
    Object.defineProperty(host, "crypto", { configurable: true, writable: true, value: target });
  }
  return "expo-crypto";
}
