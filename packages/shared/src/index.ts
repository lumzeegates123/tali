/**
 * @tali/shared: HTTP and sync wire contracts only (Zod). No business logic and
 * no utilities; pure business primitives belong in @tali/domain/kernel.
 */
export type { ErrorEnvelope } from "./contracts/http/error-envelope";
export { ErrorCodeSchema, ErrorEnvelopeSchema } from "./contracts/http/error-envelope";
export type { MoneyWire } from "./contracts/http/money";
export { CurrencyCodeWireSchema, MinorUnitsStringSchema, MoneyWireSchema } from "./contracts/http/money";
