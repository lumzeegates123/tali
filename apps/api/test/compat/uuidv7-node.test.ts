import type { IdGenerator } from "@tali/application";
import { describeIdGeneratorContract } from "@tali/application/testing/contracts";
import { parseId } from "@tali/domain";
import { v7 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Wave C UUIDv7 spike (docs/plans/002 section 2) on Node.js 24: the candidate
 * library under the shared IdGenerator contract. Not a production adapter.
 */
const candidate: IdGenerator = {
  newId: (entity) => parseId(entity, v7()),
};

describeIdGeneratorContract("uuid@14 v7 on Node.js", () => candidate);

describe("uuid@14 v7 random source on Node.js", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("draws every ID from Web Crypto getRandomValues and never from Math.random", () => {
    const secure = vi.spyOn(globalThis.crypto, "getRandomValues");
    const insecure = vi.spyOn(Math, "random");
    for (let index = 0; index < 1_000; index += 1) v7();
    expect(secure).toHaveBeenCalledTimes(1_000);
    expect(insecure).not.toHaveBeenCalled();
  });

  it("throws rather than degrading when no secure source exists", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => v7()).toThrow();
  });
});
