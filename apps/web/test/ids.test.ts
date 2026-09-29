import { afterEach, describe, expect, it, vi } from "vitest";
import { checkIdGenerator } from "../src/lib/ids/id-checks";
import { newUuidV7, SecureRandomUnavailableError, uuidV7IdGenerator } from "../src/lib/ids/uuidv7";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("web UUIDv7 generator (Vitest, jsdom on Node.js; the browser run is the Playwright spike)", () => {
  it("passes the ADR-002 section 14 acceptance checks over 10,000 IDs", () => {
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
  });

  it("draws randomness from crypto.getRandomValues and never from Math.random", () => {
    const secure = vi.spyOn(globalThis.crypto, "getRandomValues");
    const insecure = vi.spyOn(Math, "random");
    uuidV7IdGenerator.newId("Probe");
    expect(secure).toHaveBeenCalled();
    expect(insecure).not.toHaveBeenCalled();
  });

  it("refuses to generate when no secure random source exists", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => newUuidV7()).toThrow(SecureRandomUnavailableError);
  });
});
