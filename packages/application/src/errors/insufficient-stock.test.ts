import { DomainError } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { ApplicationError, InsufficientStockError } from "./application-error.js";
import { toApplicationError, withDomainRules } from "./domain-errors.js";

describe("INSUFFICIENT_STOCK (ADR-008 section 20)", () => {
  it("is a non-retryable application error", () => {
    const error = new InsufficientStockError();
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error.code).toBe("INSUFFICIENT_STOCK");
    expect(error.retryable).toBe(false);
  });

  it("is what a domain INSUFFICIENT_STOCK maps to, with a fixed message that reveals no quantity", () => {
    const mapped = toApplicationError(new DomainError("INSUFFICIENT_STOCK", "balance 3 would become -2", "quantity"));
    expect(mapped).toBeInstanceOf(InsufficientStockError);
    expect(mapped.message).not.toMatch(/[0-9]/);
    expect(() =>
      withDomainRules(() => {
        throw new DomainError("INSUFFICIENT_STOCK", "short");
      }),
    ).toThrow(InsufficientStockError);
  });
});
