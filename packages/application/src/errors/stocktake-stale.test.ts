import { MAX_STOCKTAKE_LINES, parseProductVariantId, type ProductVariantId } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { ApplicationError, STOCKTAKE_STALE_MAX_IDS, StocktakeStaleError } from "./application-error.js";

const variant = (n: number): ProductVariantId =>
  parseProductVariantId(`019a0000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);

describe("STOCKTAKE_STALE (Slice 6 decision D4)", () => {
  it("is a non-retryable application error with a generic message", () => {
    const error = new StocktakeStaleError([variant(1)], 1);
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error.code).toBe("STOCKTAKE_STALE");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("The stocktake is stale and must be recounted");
  });

  it("sorts and de-duplicates the IDs, and never puts them in the message", () => {
    const error = new StocktakeStaleError([variant(3), variant(1), variant(3), variant(2)], 3);
    expect(error.staleVariantIds).toEqual([variant(1), variant(2), variant(3)]);
    expect(error.staleLineCount).toBe(3);
    expect(error.message).not.toContain(variant(1));
    expect(Object.isFrozen(error.staleVariantIds)).toBe(true);
  });

  it("exposes exactly 50 IDs when 50 lines are stale", () => {
    const ids = Array.from({ length: 50 }, (_, i) => variant(50 - i));
    const error = new StocktakeStaleError(ids, 50);
    expect(error.staleVariantIds).toHaveLength(STOCKTAKE_STALE_MAX_IDS);
    expect(error.staleLineCount).toBe(50);
  });

  it("exposes the first 50 IDs in ascending order and the full total when more are stale", () => {
    const ids = Array.from({ length: 51 }, (_, i) => variant(51 - i));
    const fiftyOne = new StocktakeStaleError(ids, 51);
    expect(fiftyOne.staleVariantIds).toEqual(Array.from({ length: 50 }, (_, i) => variant(i + 1)));
    expect(fiftyOne.staleLineCount).toBe(51);

    const many = new StocktakeStaleError(
      Array.from({ length: 1000 }, (_, i) => variant(i + 1)),
      1000,
    );
    expect(many.staleVariantIds).toHaveLength(50);
    expect(many.staleLineCount).toBe(1000);
  });

  it("rejects a construction that could not describe a stale stocktake", () => {
    expect(() => new StocktakeStaleError([], 0)).toThrow();
    expect(() => new StocktakeStaleError([variant(1), variant(2)], 1)).toThrow();
    expect(() => new StocktakeStaleError([variant(1)], 1.5)).toThrow();
  });

  it("bounds the stale line count from 1 to MAX_STOCKTAKE_LINES", () => {
    expect(MAX_STOCKTAKE_LINES).toBe(1000);
    expect(new StocktakeStaleError([variant(1)], 1).staleLineCount).toBe(1);
    expect(new StocktakeStaleError([variant(1)], MAX_STOCKTAKE_LINES).staleLineCount).toBe(1000);
    expect(() => new StocktakeStaleError([variant(1)], 0)).toThrow();
    expect(() => new StocktakeStaleError([variant(1)], MAX_STOCKTAKE_LINES + 1)).toThrow();
    expect(() => new StocktakeStaleError([variant(1)], Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => new StocktakeStaleError([variant(1)], Number.POSITIVE_INFINITY)).toThrow();
    expect(() => new StocktakeStaleError([variant(1)], Number.NaN)).toThrow();
  });
});
