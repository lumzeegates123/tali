import { describe, expect, it } from "vitest";
import { KernelError } from "./errors.js";
import { isUuidV7, parseId, parseUuid, uuidVersion } from "./ids.js";

const V7 = "01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f";
const V4 = "3b241101-e2bb-4255-8caf-4136c566a962";

describe("parseUuid", () => {
  it("accepts RFC 9562 UUIDs and normalizes to lowercase", () => {
    expect(parseUuid(V7.toUpperCase())).toBe(V7);
    expect(uuidVersion(parseUuid(V4))).toBe(4);
  });

  it("rejects malformed values, the nil UUID and non-RFC variants", () => {
    for (const invalid of [
      "",
      "not-a-uuid",
      "00000000-0000-0000-0000-000000000000",
      "01928c6e8b3a7c4d9e5f0a1b2c3d4e5f",
      "01928c6e-8b3a-7c4d-ce5f-0a1b2c3d4e5f",
      "01928c6e-8b3a-7c4d-1e5f-0a1b2c3d4e5f",
      `{${V7}}`,
    ]) {
      expect(() => parseUuid(invalid)).toThrow(KernelError);
    }
  });
});

describe("parseId", () => {
  it("requires UUIDv7 for record identities", () => {
    const id = parseId("Business", V7);
    expect(id).toBe(V7);
    expect(isUuidV7(V7)).toBe(true);
    expect(isUuidV7(V4)).toBe(false);
    expect(() => parseId("Business", V4)).toThrow(/Business id/);
  });
});
