import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runKernelCompat } from "../src/diagnostics/kernel-compat";

const GOLDEN = join(__dirname, "fixtures", "kernel-compat.golden.json");

/*
 * The golden file is the Node.js 24 output of the same function; the Hermes
 * release build's logcat report must match it byte for byte
 * (scripts/compare-device-report.mjs). Regenerate only when a case is added:
 *   UPDATE_GOLDEN=1 pnpm --filter @tali/mobile test -- kernel-compat
 */
describe("kernel compatibility report", () => {
  it("uses the bigint primitive", () => {
    expect(runKernelCompat().bigintPrimitive).toBe("bigint");
  });

  it("matches the committed golden output byte for byte", () => {
    const actual = `${JSON.stringify(runKernelCompat(), null, 2)}\n`;
    if (process.env["UPDATE_GOLDEN"] === "1") {
      writeFileSync(GOLDEN, actual);
    }
    expect(actual).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("records no unexpected error outcome", () => {
    const expectedErrors: Record<string, string> = {
      "parse.rejectsExcessPrecision": "INVALID_MONEY_AMOUNT",
      "parse.rejectsExponent": "INVALID_MONEY_AMOUNT",
      "parse.rejectsNegativeZero": "INVALID_MONEY_AMOUNT",
      "parse.rejectsNumber": "INVALID_MONEY_AMOUNT",
      "rounding.rejectsDivisionByZero": "DIVISION_BY_ZERO",
      "currency.rejectsMixedAdd": "CURRENCY_MISMATCH",
      "currency.rejectsMixedCompare": "CURRENCY_MISMATCH",
      "currency.rejectsMixedSum": "CURRENCY_MISMATCH",
      "wire.refusesImplicitJson": "MONEY_NOT_SERIALIZABLE",
      "time.rejectsUnknownZone": "INVALID_TIME_ZONE",
    };
    const errors = Object.fromEntries(
      Object.entries(runKernelCompat().cases).flatMap(([name, outcome]) =>
        "error" in outcome ? [[name, outcome.error]] : [],
      ),
    );
    expect(errors).toEqual(expectedErrors);
  });
});
