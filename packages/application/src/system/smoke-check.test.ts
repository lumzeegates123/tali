import { describe, expect, it } from "vitest";
import { parseCorrelationId } from "../context/business-context.js";
import { ValidationError } from "../errors/application-error.js";
import { FixedClock } from "../testing/fixed-clock.js";
import { createSmokeCheck, SMOKE_CHECK_MESSAGE_TYPE } from "./smoke-check.js";

describe("SmokeCheck", () => {
  const clock = new FixedClock("2026-09-27T10:00:00Z");
  const smokeCheck = createSmokeCheck({ clock });
  const correlationId = parseCorrelationId("smoke-1");

  it("echoes the request, stamped with the clock", async () => {
    await expect(smokeCheck.execute({ correlationId, note: "hello" })).resolves.toEqual({
      correlationId,
      note: "hello",
      checkedAt: new Date("2026-09-27T10:00:00Z"),
    });
  });

  it("rejects an oversized note", async () => {
    await expect(smokeCheck.execute({ correlationId, note: "x".repeat(201) })).rejects.toBeInstanceOf(ValidationError);
  });

  it("has a stable message type", () => {
    expect(SMOKE_CHECK_MESSAGE_TYPE).toBe("system.smoke-check");
  });
});
