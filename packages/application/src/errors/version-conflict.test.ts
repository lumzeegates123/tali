import { DomainError } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { ApplicationError, VersionConflictError } from "./application-error.js";
import { toApplicationError, withDomainRules } from "./domain-errors.js";

describe("VERSION_CONFLICT (ADR-008 section 20)", () => {
  it("is a non-retryable application error", () => {
    const error = new VersionConflictError();
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error.code).toBe("VERSION_CONFLICT");
    expect(error.retryable).toBe(false);
  });

  it("is what a domain VERSION_CONFLICT maps to, with a fixed message", () => {
    const mapped = toApplicationError(new DomainError("VERSION_CONFLICT", "internal detail", "expectedVersion"));
    expect(mapped).toBeInstanceOf(VersionConflictError);
    expect(mapped.message).not.toContain("internal detail");
    expect(() =>
      withDomainRules(() => {
        throw new DomainError("VERSION_CONFLICT", "stale");
      }),
    ).toThrow(VersionConflictError);
  });
});
