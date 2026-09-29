# bigint Money under Expo / Hermes: compatibility report

- Date: 2026-09-28 (Wave C)
- Scope: ADR-002 section 10, mobile compatibility acceptance check 1; plan
  `docs/plans/002-wave-c-compatibility-checks.md` section 1.
- Versions: Expo SDK 57.0.25, React Native 0.86.3, Hermes (bundled with React Native
  0.86; runtime reports OSS release `250829098.0.17`), expo-router 57.0.23,
  jest-expo 57.0.5 on Jest 29.7.0, Node.js 24.21.0.
- Device: Android emulator `Pixel6aAPI30` (Android 11, API 30, Google APIs,
  x86_64), release build (`assembleRelease`, x86_64 only), JavaScript compiled to
  Hermes bytecode. No Metro server; no development mode.
- Evidence: `apps/mobile/src/diagnostics/kernel-compat.ts` (the cases),
  `apps/mobile/test/fixtures/kernel-compat.golden.json` (Node.js output),
  `apps/mobile/scripts/compare-device-report.mjs` (device vs golden comparison),
  `apps/mobile/test/kernel-compat.test.ts`, and the `kernel-expo-babel` Jest project
  in `apps/mobile/jest.config.js`.

## Result: PASS

`bigint` is a native primitive on Hermes and the client-safe Money kernel produces the
same results on the device as on Node.js 24, byte for byte, for every case below. No
floating-point fallback exists or was introduced.

## Method

1. **On-device run (the acceptance evidence).** The release APK opens the non-production
   diagnostics route (`tali://diagnostics`), which calls `runRuntimeReport()` and logs one
   line prefixed `TALI_COMPAT_REPORT `. The line was read with `adb logcat` and checked with
   `node apps/mobile/scripts/compare-device-report.mjs <logcat file>`, which requires:
   `engine.hermes === true`; the `kernel` section serialised with two-space indentation
   equal, byte for byte, to `kernel-compat.golden.json`; and the UUIDv7 checks passed.
   The golden file is the output of the same function on Node.js 24 (Jest).
2. **Negative control of the comparison.** Changing one device value
   (`parse.minorUnits` 125050 to 125051) made the script fail with
   `kernel case parse.minorUnits: device {"value":"125051"}, golden {"value":"125050"}`.
3. **Kernel unit suites under the Expo Babel toolchain.** The unchanged
   `packages/domain/src/kernel/*.test.ts` suites (except `surface.test.ts`, which reads the
   file system) run in the `kernel-expo-babel` Jest project with the jest-expo preset, so
   the kernel source goes through the same Babel preset Metro uses. This proves the
   transform keeps bigint literals and operators intact. Jest executes on Node.js (V8),
   not Hermes; engine behaviour is covered by step 1, not by this step.

Device engine report:

```json
{ "hermes": true, "hermesVersion": "250829098.0.17", "strictModeModules": true }
```

## Cases (39, all identical to Node.js)

| Area | Cases | Notes |
| --- | --- | --- |
| Creation and parsing | `parse.minorUnits`, `parse.decimal`, `parse.decimalNegative`, `parse.decimalZeroDigits` (JPY), `parse.decimalThreeDigits` (BHD) | Minor units from strings and decimal strings |
| Parsing rejections | `parse.rejectsExcessPrecision`, `parse.rejectsExponent`, `parse.rejectsNegativeZero`, `parse.rejectsNumber` | All `INVALID_MONEY_AMOUNT`; a JS `number` is refused |
| Add / subtract | `arithmetic.add`, `arithmetic.subtract`, `arithmetic.negateAbs`, `arithmetic.sum`, `arithmetic.sumEmpty` | |
| Immutability | `immutability.frozen` | Frozen instance, value unchanged after a write attempt |
| Compare | `compare.order`, `compare.equals` | |
| Above `Number.MAX_SAFE_INTEGER` | `large.aboveMaxSafeInteger` (18014398509481986), `large.multiply` (9007199317791387783186951), `large.bigintRangeRoundTrip` (PostgreSQL BIGINT min/max through `BigInt(string)` and `toString()`), `large.decimalFormat` | No precision loss |
| Formatting | `format.decimal` | Deterministic decimal strings for 2-, 0- and 3-digit currencies |
| Rounding | `rounding.divideAndRound` (7 modes x 7 inputs), `rounding.multiplyByFraction` (7 modes), `rounding.rejectsDivisionByZero` | HALF_EVEN, HALF_UP, HALF_DOWN, UP, DOWN, CEILING, FLOOR |
| Allocation | `allocation.byWeights`, `allocation.evenly`, `allocation.negative`, `allocation.largeEvenly`, `allocation.preservesTotal` | Largest remainder; totals preserved above 2^53 |
| Mixed currency | `currency.rejectsMixedAdd`, `currency.rejectsMixedCompare`, `currency.rejectsMixedSum` | All `CURRENCY_MISMATCH` |
| Wire conversion | `wire.refusesImplicitJson` (`MONEY_NOT_SERIALIZABLE`), `wire.roundTrip` (amount stays a string: `{"amountMinor":"9007199254740993","currency":"NGN"}`), `wire.rejectsNumericAmount` | No `number` coercion anywhere |
| Business date (Intl) | `time.lagosAfterUtcMidnight` (2026-01-02), `time.chicagoBeforeUtcMidnight` (2025-12-31), `time.rejectsUnknownZone` | Hermes `Intl.DateTimeFormat` with `timeZone` is sufficient; no polyfill needed |

The test currencies (NGN, USD, JPY, BHD) are test data only; the kernel takes the
currency from the amount and hardcodes none.

## Findings

- **Strict-mode difference between Jest and the release bundle.** Under jest-expo, React
  Native's Babel module transform emits sloppy-mode modules, so writing to a frozen object
  is silently ignored instead of throwing `TypeError`. The kernel suite's "is immutable"
  test asserted the throw, so it was changed to accept either outcome while still
  requiring the value to be unchanged (`packages/domain/src/kernel/money.test.ts`). On the
  device the release bundle runs in strict mode (`strictModeModules: true`). The kernel's
  immutability guarantee (frozen instances) holds in both cases; only the observable error
  differs. This is the one change made to a kernel suite.
- **Emulator, not a physical device.** The plan permits an emulator. API 30 was used
  because the API 33 image needed 7.4 GB of free disk space to create its data partition,
  which the development machine did not have.
- **Not automated in CI.** CI runs the Jest projects (including the golden comparison
  on Node.js) and the Android `expo export`, which compiles to Hermes bytecode, but it does
  not boot an emulator. The on-device run is a manual, repeatable procedure (below).
  Automating it belongs with the deferred mobile end-to-end tool (ADR-002 section 17).

## Reproduce

```text
cd apps/mobile
pnpm exec expo prebuild --platform android               # android/ is gitignored
# android/local.properties: cmake.dir=<sdk>/cmake/3.31.6 (see foundation-wave-c.md)
EXPO_PUBLIC_TALI_ENV=local EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3910 \
  android/gradlew -p android assembleRelease -PreactNativeArchitectures=x86_64
adb install -r android/app/build/outputs/apk/release/app-release.apk
adb logcat -c && adb shell am start -a android.intent.action.VIEW -d tali://diagnostics com.tali.mobile
adb logcat -d -s ReactNativeJS:I > logcat.txt
node scripts/compare-device-report.mjs logcat.txt
```
