import type { CurrencyDefinition, RoundingMode as RoundingModeValue } from "@tali/domain/kernel";
import {
  allocateByWeights,
  allocateEvenly,
  BusinessDate,
  defineCurrency,
  divideAndRound,
  KernelError,
  Money,
  parseTimeZoneId,
  RoundingMode,
} from "@tali/domain/kernel";
import { MoneyWireSchema } from "@tali/shared";

/*
 * Wave C bigint/Hermes compatibility cases (docs/plans/002 section 1). The
 * report is deterministic: it contains only strings, booleans and kernel error
 * codes, so the Hermes release build and Node.js must produce byte-identical
 * JSON (compared against test/fixtures/kernel-compat.golden.json). Currencies
 * are test data covering 0, 2 and 3 minor-unit digits.
 */

type Outcome = { readonly value: string } | { readonly error: string };

function attempt(work: () => string): Outcome {
  try {
    return { value: work() };
  } catch (error) {
    if (error instanceof KernelError) return { error: error.code };
    if (error instanceof Error) return { error: error.name };
    return { error: "unknown" };
  }
}

const TWO: CurrencyDefinition = defineCurrency("NGN", 2);
const OTHER: CurrencyDefinition = defineCurrency("USD", 2);
const ZERO_DIGITS: CurrencyDefinition = defineCurrency("JPY", 0);
const THREE_DIGITS: CurrencyDefinition = defineCurrency("BHD", 3);

const minor = (amount: bigint): Money => Money.ofMinor(amount, TWO.code);
const list = (amounts: readonly Money[]): string => amounts.map((amount) => amount.toMinorUnitsString()).join(",");

const MODES: readonly RoundingModeValue[] = [
  RoundingMode.HALF_EVEN,
  RoundingMode.HALF_UP,
  RoundingMode.HALF_DOWN,
  RoundingMode.UP,
  RoundingMode.DOWN,
  RoundingMode.CEILING,
  RoundingMode.FLOOR,
];
const ROUNDING_NUMERATORS: readonly bigint[] = [25n, -25n, 15n, -15n, 26n, -26n, 24n];

export interface KernelCompatReport {
  readonly bigintPrimitive: string;
  readonly cases: Readonly<Record<string, Outcome>>;
}

export function runKernelCompat(): KernelCompatReport {
  const cases: Record<string, Outcome> = {
    "parse.minorUnits": attempt(() => Money.fromMinorUnitsString("125050", TWO.code).toMinorUnitsString()),
    "parse.decimal": attempt(() => Money.fromDecimalString("1250.50", TWO).toMinorUnitsString()),
    "parse.decimalNegative": attempt(() => Money.fromDecimalString("-0.05", TWO).toMinorUnitsString()),
    "parse.decimalZeroDigits": attempt(() => Money.fromDecimalString("1250", ZERO_DIGITS).toMinorUnitsString()),
    "parse.decimalThreeDigits": attempt(() => Money.fromDecimalString("1.005", THREE_DIGITS).toMinorUnitsString()),
    "parse.rejectsExcessPrecision": attempt(() => Money.fromDecimalString("12.345", TWO).toMinorUnitsString()),
    "parse.rejectsExponent": attempt(() => Money.fromMinorUnitsString("1e3", TWO.code).toMinorUnitsString()),
    "parse.rejectsNegativeZero": attempt(() => Money.fromMinorUnitsString("-0", TWO.code).toMinorUnitsString()),
    "parse.rejectsNumber": attempt(() => Money.ofMinor(12.5 as unknown as bigint, TWO.code).toMinorUnitsString()),
    "arithmetic.add": attempt(() => minor(1999n).add(minor(1n)).toMinorUnitsString()),
    "arithmetic.subtract": attempt(() => minor(1000n).subtract(minor(2500n)).toMinorUnitsString()),
    "arithmetic.negateAbs": attempt(
      () => `${minor(42n).negate().toMinorUnitsString()}|${minor(-42n).abs().toMinorUnitsString()}`,
    ),
    "arithmetic.sum": attempt(() => Money.sum(TWO.code, [minor(1n), minor(2n), minor(3n)]).toMinorUnitsString()),
    "arithmetic.sumEmpty": attempt(() => Money.sum(TWO.code, []).toMinorUnitsString()),
    "immutability.frozen": attempt(() => {
      const money = minor(1n);
      try {
        (money as { amountMinor: bigint }).amountMinor = 2n;
      } catch {
        // Strict-mode modules throw here; the outcome that matters is the unchanged value.
      }
      return `${Object.isFrozen(money)}|${money.toMinorUnitsString()}`;
    }),
    "compare.order": attempt(() =>
      [minor(1n).compare(minor(2n)), minor(2n).compare(minor(2n)), minor(3n).compare(minor(2n))].join(","),
    ),
    "compare.equals": attempt(() => `${minor(7n).equals(minor(7n))}|${minor(7n).equals(minor(8n))}`),
    "large.aboveMaxSafeInteger": attempt(() =>
      minor(9_007_199_254_740_993n).add(minor(9_007_199_254_740_993n)).toMinorUnitsString(),
    ),
    "large.multiply": attempt(() => minor(9_007_199_254_740_993n).multiply(1_000_000_007n).toMinorUnitsString()),
    "large.bigintRangeRoundTrip": attempt(() =>
      [
        Money.fromMinorUnitsString("9223372036854775807", TWO.code).toMinorUnitsString(),
        Money.fromMinorUnitsString("-9223372036854775808", TWO.code).toMinorUnitsString(),
        BigInt("9223372036854775807").toString(),
        (2n ** 63n - 1n).toString(),
      ].join("|"),
    ),
    "large.decimalFormat": attempt(() => minor(9_007_199_254_740_993n).toDecimalString(TWO)),
    "format.decimal": attempt(() =>
      [
        minor(125050n).toDecimalString(TWO),
        minor(-5n).toDecimalString(TWO),
        Money.ofMinor(1250n, ZERO_DIGITS.code).toDecimalString(ZERO_DIGITS),
        Money.ofMinor(1005n, THREE_DIGITS.code).toDecimalString(THREE_DIGITS),
      ].join("|"),
    ),
    "rounding.divideAndRound": attempt(() =>
      MODES.map(
        (mode) => `${mode}:${ROUNDING_NUMERATORS.map((n) => divideAndRound(n, 10n, mode).toString()).join(",")}`,
      ).join("|"),
    ),
    "rounding.multiplyByFraction": attempt(() =>
      MODES.map((mode) => `${mode}:${minor(1005n).multiplyByFraction(1n, 2n, mode).toMinorUnitsString()}`).join("|"),
    ),
    "rounding.rejectsDivisionByZero": attempt(() => divideAndRound(1n, 0n, RoundingMode.HALF_EVEN).toString()),
    "allocation.byWeights": attempt(() => list(minor(100n).allocate([1n, 1n, 1n]))),
    "allocation.evenly": attempt(() => list(minor(10_001n).allocateEvenly(3))),
    "allocation.negative": attempt(() => allocateByWeights(-100n, [1n, 2n]).join(",")),
    "allocation.largeEvenly": attempt(() => allocateEvenly(9_007_199_254_740_993n, 7).join(",")),
    "allocation.preservesTotal": attempt(() =>
      Money.sum(TWO.code, minor(9_007_199_254_740_993n).allocate([3n, 5n, 11n])).toMinorUnitsString(),
    ),
    "currency.rejectsMixedAdd": attempt(() => minor(1n).add(Money.ofMinor(1n, OTHER.code)).toMinorUnitsString()),
    "currency.rejectsMixedCompare": attempt(() => String(minor(1n).compare(Money.ofMinor(1n, OTHER.code)))),
    "currency.rejectsMixedSum": attempt(() =>
      Money.sum(TWO.code, [minor(1n), Money.ofMinor(1n, OTHER.code)]).toMinorUnitsString(),
    ),
    "wire.refusesImplicitJson": attempt(() => JSON.stringify({ total: minor(1n) })),
    "wire.roundTrip": attempt(() => {
      const original = minor(9_007_199_254_740_993n);
      const json = JSON.stringify({ amountMinor: original.toMinorUnitsString(), currency: original.currency });
      const wire = MoneyWireSchema.parse(JSON.parse(json));
      const restored = Money.fromMinorUnitsString(wire.amountMinor, original.currency);
      return `${json}|${typeof wire.amountMinor}|${restored.equals(original)}`;
    }),
    "wire.rejectsNumericAmount": attempt(() =>
      String(MoneyWireSchema.safeParse({ amountMinor: 100, currency: TWO.code }).success),
    ),
    "time.lagosAfterUtcMidnight": attempt(() =>
      BusinessDate.fromInstant(new Date(Date.UTC(2026, 0, 1, 23, 30)), parseTimeZoneId("Africa/Lagos")).toString(),
    ),
    "time.chicagoBeforeUtcMidnight": attempt(() =>
      BusinessDate.fromInstant(new Date(Date.UTC(2026, 0, 1, 3, 0)), parseTimeZoneId("America/Chicago")).toString(),
    ),
    "time.rejectsUnknownZone": attempt(() => parseTimeZoneId("Not/AZone")),
  };
  return { bigintPrimitive: typeof 1n, cases };
}
