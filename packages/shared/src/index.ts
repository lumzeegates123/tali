/**
 * @tali/shared: HTTP and sync wire contracts only (Zod). No business logic and
 * no utilities; pure business primitives belong in @tali/domain/kernel.
 */
export type { ErrorEnvelope } from "./contracts/http/error-envelope.js";
export { ErrorCodeSchema, ErrorEnvelopeSchema } from "./contracts/http/error-envelope.js";
export type { LivenessResponse, ReadinessResponse } from "./contracts/http/health.js";
export { DependencyStatusSchema, LivenessResponseSchema, ReadinessResponseSchema } from "./contracts/http/health.js";
export type { MoneyWire } from "./contracts/http/money.js";
export { CurrencyCodeWireSchema, MinorUnitsStringSchema, MoneyWireSchema } from "./contracts/http/money.js";
