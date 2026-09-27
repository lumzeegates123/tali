import { isUuidV7 } from "@tali/domain";
import { describe, expect, it } from "vitest";
import type { Clock } from "../../ports/clock";
import type { IdGenerator } from "../../ports/id-generator";
import type { UnitOfWork } from "../../ports/unit-of-work";

/**
 * UUIDv7 acceptance checks from ADR-002 section 14 (version and variant bits,
 * uniqueness under bulk generation, monotonic ordering). The same suite is the
 * harness for the production generator on Node.js, browser and Expo.
 */
export function describeIdGeneratorContract(name: string, create: () => IdGenerator, bulkCount = 10_000): void {
  describe(`IdGenerator contract: ${name}`, () => {
    it("generates RFC 9562 UUIDv7 values in canonical form", () => {
      const id = create().newId("Contract");
      expect(isUuidV7(id)).toBe(true);
      expect(id).toBe(id.toLowerCase());
      expect(["8", "9", "a", "b"]).toContain(id.charAt(19));
    });

    it("never repeats and stays monotonically ordered under bulk generation", () => {
      const generator = create();
      const ids = Array.from({ length: bulkCount }, () => generator.newId("Contract"));
      expect(new Set(ids).size).toBe(bulkCount);
      for (let index = 1; index < ids.length; index += 1) {
        expect((ids[index] ?? "") > (ids[index - 1] ?? "")).toBe(true);
      }
    });
  });
}

export function describeClockContract(name: string, create: () => Clock): void {
  describe(`Clock contract: ${name}`, () => {
    it("returns a valid instant as a fresh Date each call", () => {
      const clock = create();
      const first = clock.now();
      expect(Number.isNaN(first.getTime())).toBe(false);
      first.setTime(0);
      expect(clock.now().getTime()).not.toBe(0);
    });

    it("never moves backwards", () => {
      const clock = create();
      const first = clock.now().getTime();
      expect(clock.now().getTime()).toBeGreaterThanOrEqual(first);
    });
  });
}

export function describeUnitOfWorkContract(name: string, create: () => UnitOfWork): void {
  describe(`UnitOfWork contract: ${name}`, () => {
    it("returns the result of successful work", async () => {
      await expect(create().run(async () => 42)).resolves.toBe(42);
    });

    it("propagates the error thrown by failed work", async () => {
      const failure = new Error("boom");
      await expect(
        create().run(async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    });

    it("accepts an explicit isolation level", async () => {
      await expect(create().run(async () => "ok", { isolationLevel: "serializable" })).resolves.toBe("ok");
    });
  });
}
