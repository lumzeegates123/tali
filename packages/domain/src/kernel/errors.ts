export type KernelErrorCode =
  | "INVALID_CURRENCY_CODE"
  | "INVALID_CURRENCY_DEFINITION"
  | "CURRENCY_MISMATCH"
  | "INVALID_MONEY_AMOUNT"
  | "MONEY_NOT_SERIALIZABLE"
  | "DIVISION_BY_ZERO"
  | "INVALID_ROUNDING_MODE"
  | "INVALID_ALLOCATION"
  | "INVALID_UUID"
  | "INVALID_BUSINESS_DATE"
  | "INVALID_TIME_ZONE"
  | "INVALID_UNIT_CODE"
  | "INVALID_UNIT_DEFINITION"
  | "UNIT_MISMATCH"
  | "INVALID_QUANTITY"
  | "QUANTITY_OUT_OF_RANGE"
  | "QUANTITY_NOT_SERIALIZABLE";

/** Raised when a kernel value-object invariant or arithmetic precondition is violated. */
export class KernelError extends Error {
  readonly code: KernelErrorCode;

  constructor(code: KernelErrorCode, message: string) {
    super(message);
    this.name = "KernelError";
    this.code = code;
  }
}
