import { describeIdGeneratorContract } from "@tali/application/testing/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecureRandomUnavailableError, uuidV7IdGenerator } from "./uuidv7-id-generator.js";

describeIdGeneratorContract("uuidV7IdGenerator (uuid@14 v7, Node.js)", () => uuidV7IdGenerator);

describe("uuidV7IdGenerator random source", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("draws from Web Crypto getRandomValues and never from Math.random", () => {
    const secure = vi.spyOn(globalThis.crypto, "getRandomValues");
    const insecure = vi.spyOn(Math, "random");
    for (let index = 0; index < 100; index += 1) uuidV7IdGenerator.newId("Probe");
    expect(secure).toHaveBeenCalled();
    expect(insecure).not.toHaveBeenCalled();
  });

  it("refuses to generate an identifier without a secure random source", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => uuidV7IdGenerator.newId("Probe")).toThrow(SecureRandomUnavailableError);
  });
});
