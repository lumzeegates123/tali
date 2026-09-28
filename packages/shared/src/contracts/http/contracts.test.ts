import { describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema } from "./error-envelope.js";
import { LivenessResponseSchema, ReadinessResponseSchema } from "./health.js";
import { MoneyWireSchema } from "./money.js";

describe("MoneyWireSchema", () => {
  it("accepts the ADR-002 wire format", () => {
    expect(MoneyWireSchema.parse({ amountMinor: "125050", currency: "NGN" })).toEqual({
      amountMinor: "125050",
      currency: "NGN",
    });
    expect(MoneyWireSchema.safeParse({ amountMinor: "-9223372036854775808", currency: "USD" }).success).toBe(true);
    expect(MoneyWireSchema.safeParse({ amountMinor: "9223372036854775807", currency: "JPY" }).success).toBe(true);
  });

  it("rejects JSON numbers, decimals and malformed amounts", () => {
    for (const amountMinor of [125050, "1250.50", "01", "-0", "1e5", "", " 1", "9223372036854775808"]) {
      expect(MoneyWireSchema.safeParse({ amountMinor, currency: "NGN" }).success).toBe(false);
    }
  });

  it("rejects malformed currencies and unknown fields", () => {
    expect(MoneyWireSchema.safeParse({ amountMinor: "1", currency: "ngn" }).success).toBe(false);
    expect(MoneyWireSchema.safeParse({ amountMinor: "1", currency: "NGN", extra: true }).success).toBe(false);
  });
});

describe("health contracts", () => {
  it("accepts the liveness and readiness bodies", () => {
    expect(LivenessResponseSchema.safeParse({ status: "ok" }).success).toBe(true);
    expect(ReadinessResponseSchema.safeParse({ status: "ready", checks: { database: "up" } }).success).toBe(true);
    expect(ReadinessResponseSchema.safeParse({ status: "not_ready", checks: { database: "down" } }).success).toBe(true);
  });

  it("rejects leaked detail such as error messages or connection strings", () => {
    expect(
      ReadinessResponseSchema.safeParse({ status: "not_ready", checks: { database: "down" }, error: "ECONNREFUSED" })
        .success,
    ).toBe(false);
    expect(ReadinessResponseSchema.safeParse({ status: "ready", checks: { database: "postgres://x" } }).success).toBe(
      false,
    );
  });
});

describe("ErrorEnvelopeSchema", () => {
  it("accepts the standard error body", () => {
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: "NOT_FOUND", message: "Not found" } }).success).toBe(true);
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: { code: "VALIDATION_FAILED", message: "Invalid", details: [{ path: ["name"] }] },
      }).success,
    ).toBe(true);
  });

  it("rejects non-standard codes and extra fields such as stack traces", () => {
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: "not_found", message: "x" } }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: "X", message: "x", stack: "at ..." } }).success).toBe(false);
  });
});
