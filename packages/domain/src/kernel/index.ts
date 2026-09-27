/**
 * @tali/domain/kernel: the client-safe kernel (ADR-002 section 6).
 * Pure value objects and deterministic arithmetic, rounding, allocation and
 * formatting only. Never add authorization, posting, business mutations or
 * commit-capable state transitions here; the surface is pinned by
 * surface.test.ts.
 */
export { allocateByWeights, allocateEvenly } from "./allocation";
export type { CurrencyCode, CurrencyDefinition } from "./currency";
export { defineCurrency, isCurrencyCode, MAX_MINOR_UNIT_DIGITS, parseCurrencyCode } from "./currency";
export type { KernelErrorCode } from "./errors";
export { KernelError } from "./errors";
export type { Id, Uuid } from "./ids";
export { isUuidV7, parseId, parseUuid, uuidVersion } from "./ids";
export { Money } from "./money";
export { absBigInt, divideAndRound, RoundingMode } from "./rounding";
export type { TimeZoneId } from "./time";
export { BusinessDate, parseTimeZoneId } from "./time";
