/**
 * @tali/domain/kernel: the client-safe kernel (ADR-002 section 6).
 * Pure value objects and deterministic arithmetic, rounding, allocation and
 * formatting only. Never add authorization, posting, business mutations or
 * commit-capable state transitions here; the surface is pinned by
 * surface.test.ts.
 */
export { allocateByWeights, allocateEvenly } from "./allocation.js";
export type { CurrencyCode, CurrencyDefinition } from "./currency.js";
export { defineCurrency, isCurrencyCode, MAX_MINOR_UNIT_DIGITS, parseCurrencyCode } from "./currency.js";
export type { KernelErrorCode } from "./errors.js";
export { KernelError } from "./errors.js";
export type { Id, Uuid } from "./ids.js";
export { isUuidV7, parseId, parseUuid, uuidVersion } from "./ids.js";
export { Money } from "./money.js";
export { absBigInt, divideAndRound, RoundingMode } from "./rounding.js";
export type { TimeZoneId } from "./time.js";
export { BusinessDate, parseTimeZoneId } from "./time.js";
