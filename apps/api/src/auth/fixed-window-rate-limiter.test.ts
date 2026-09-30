import { FixedClock } from "@tali/application/testing";
import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "./fixed-window-rate-limiter.js";

function limiter(overrides: Partial<{ limit: number; windowMs: number; maxKeys: number }> = {}) {
  const clock = new FixedClock("2026-09-29T08:00:00.000Z");
  return {
    clock,
    limiter: new FixedWindowRateLimiter({ clock, limit: 3, windowMs: 60_000, maxKeys: 2, ...overrides }),
  };
}

describe("FixedWindowRateLimiter", () => {
  it("allows the limit per window per key, then refuses until the window ends", () => {
    const { clock, limiter: rate } = limiter();
    expect([1, 2, 3, 4].map(() => rate.tryConsume("a"))).toEqual([true, true, true, false]);
    expect(rate.tryConsume("b")).toBe(true);
    clock.advanceBy(59_999);
    expect(rate.tryConsume("a")).toBe(false);
    clock.advanceBy(1);
    expect(rate.tryConsume("a")).toBe(true);
  });

  it("bounds memory: prunes expired windows and refuses new keys while full", () => {
    const { clock, limiter: rate } = limiter();
    expect(rate.tryConsume("a")).toBe(true);
    expect(rate.tryConsume("b")).toBe(true);
    expect(rate.tryConsume("c")).toBe(false);
    expect(rate.size).toBe(2);
    clock.advanceBy(60_000);
    expect(rate.tryConsume("c")).toBe(true);
    expect(rate.size).toBe(1);
  });

  it("rejects invalid settings", () => {
    expect(() => limiter({ limit: 0 })).toThrow();
    expect(() => limiter({ windowMs: 1.5 })).toThrow();
    expect(() => limiter({ maxKeys: -1 })).toThrow();
  });
});
