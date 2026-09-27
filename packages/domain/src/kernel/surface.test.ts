import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import * as kernel from "./index";

/**
 * The client-safe kernel surface is pinned. Adding an export requires changing
 * this list in review, and must respect ADR-002 section 6: value objects and
 * deterministic arithmetic only.
 */
const APPROVED_RUNTIME_EXPORTS = [
  "BusinessDate",
  "KernelError",
  "MAX_MINOR_UNIT_DIGITS",
  "Money",
  "RoundingMode",
  "absBigInt",
  "allocateByWeights",
  "allocateEvenly",
  "defineCurrency",
  "divideAndRound",
  "isCurrencyCode",
  "isUuidV7",
  "parseCurrencyCode",
  "parseId",
  "parseTimeZoneId",
  "parseUuid",
  "uuidVersion",
];

const FORBIDDEN_CONCEPTS =
  /post|ledger|journal|commit|authori[sz]|permission|mutat|settle|confirm|approve|repository|transaction/i;

describe("@tali/domain/kernel surface", () => {
  it("exports exactly the approved runtime values", () => {
    expect(Object.keys(kernel).sort()).toEqual([...APPROVED_RUNTIME_EXPORTS].sort());
  });

  it("exposes no authorization, posting or commit-capable operations", () => {
    for (const name of Object.keys(kernel)) {
      expect(name).not.toMatch(FORBIDDEN_CONCEPTS);
    }
    const moneyMethods = Object.getOwnPropertyNames(kernel.Money.prototype);
    for (const method of moneyMethods) {
      expect(method).not.toMatch(FORBIDDEN_CONCEPTS);
    }
  });

  it("exposes only the root and kernel subpaths from the package", () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual([".", "./kernel"]);
    expect(packageJson.exports["./kernel"].default).toBe("./src/kernel/index.ts");
  });

  it("has no runtime dependencies", () => {
    expect("dependencies" in packageJson).toBe(false);
    expect("peerDependencies" in packageJson).toBe(false);
  });
});
