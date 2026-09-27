import { describe, expect, it } from "vitest";
import { isObjectKey } from "./object-storage-provider";

describe("isObjectKey", () => {
  it("accepts relative, slash-separated keys", () => {
    expect(isObjectKey("business/01928c6e/receipts/2026/09/r1.jpg")).toBe(true);
    expect(isObjectKey("file.name-with_chars(1).pdf")).toBe(true);
  });

  it("rejects traversal, absolute, empty and unusual keys", () => {
    for (const invalid of ["", "/abs", "a//b", "../x", "a/../b", "a/./b", ".", "..", "a b", "a\\b", "x".repeat(1025)]) {
      expect(isObjectKey(invalid)).toBe(false);
    }
  });
});
