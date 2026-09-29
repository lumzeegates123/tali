import type * as NodeCrypto from "node:crypto";
import { webcrypto } from "node:crypto";
import { getRandomValues } from "expo-crypto";
import { checkIdGenerator } from "../src/ids/id-checks";
import { installSecureRandom } from "../src/ids/secure-random";
import { newUuidV7, SecureRandomUnavailableError } from "../src/ids/uuidv7";

jest.mock("expo-crypto", () => ({
  getRandomValues: jest.fn(<T extends ArrayBufferView>(array: T): T => {
    // Stands in for the native module; the real SecureRandom path is exercised on the Hermes build.
    return jest.requireActual<typeof NodeCrypto>("node:crypto").webcrypto.getRandomValues(array as never);
  }),
  randomUUID: jest.fn(() => "00000000-0000-4000-8000-000000000000"),
}));

const nativeCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");

function withoutGlobalCrypto(work: () => void): void {
  Object.defineProperty(globalThis, "crypto", { configurable: true, writable: true, value: undefined });
  try {
    work();
  } finally {
    if (nativeCrypto === undefined) Reflect.deleteProperty(globalThis, "crypto");
    else Object.defineProperty(globalThis, "crypto", nativeCrypto);
  }
}

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe("secure random installation", () => {
  it("keeps a platform Web Crypto implementation when one exists", () => {
    const host = { crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } as Partial<Crypto> };
    expect(installSecureRandom(host)).toBe("platform");
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("installs expo-crypto when the runtime has no getRandomValues, idempotently", () => {
    const host: { crypto?: Partial<Crypto> } = {};
    expect(installSecureRandom(host)).toBe("expo-crypto");
    expect(installSecureRandom(host)).toBe("expo-crypto");
    const bytes = new Uint8Array(16);
    host.crypto?.getRandomValues?.(bytes);
    expect(getRandomValues).toHaveBeenCalledWith(bytes);
  });

  it("rejects non-integer typed arrays like Web Crypto does", () => {
    const host: { crypto?: Partial<Crypto> } = {};
    installSecureRandom(host);
    expect(() => {
      host.crypto?.getRandomValues?.(new Float32Array(4) as never);
    }).toThrow(TypeError);
  });
});

describe("UUIDv7 generation (uuid@14, same library and semantics as web and Node.js)", () => {
  it("refuses to generate without a secure random source", () => {
    withoutGlobalCrypto(() => {
      expect(() => newUuidV7()).toThrow(SecureRandomUnavailableError);
    });
  });

  it("passes the ADR-002 checks through the expo-crypto source, with no Math.random", () => {
    withoutGlobalCrypto(() => {
      expect(installSecureRandom()).toBe("expo-crypto");
      const report = checkIdGenerator(newUuidV7);
      expect(report).toEqual({
        count: 10_000,
        allUuidV7: true,
        allRfcVariant: true,
        allCanonical: true,
        unique: true,
        strictlyIncreasing: true,
        randomSourceCalls: { getRandomValues: 10_000, mathRandom: 0 },
        passed: true,
      });
      expect(getRandomValues).toHaveBeenCalledTimes(10_000);
    });
  });
});
