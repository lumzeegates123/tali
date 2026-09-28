import { createSmokeCheck, SMOKE_CHECK_MESSAGE_TYPE, ValidationError, type QueueMessage } from "@tali/application";
import { FixedClock } from "@tali/application/testing";
import { describe, expect, it } from "vitest";
import { JsonLogger } from "../../observability/logger.js";
import { SmokeMessageHandler } from "./smoke.handler.js";

function setup() {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger({
    service: "t",
    level: "debug",
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const handler = new SmokeMessageHandler(createSmokeCheck({ clock: new FixedClock("2026-09-27T10:00:00Z") }), logger);
  return { handler, lines };
}

const message = (payload: QueueMessage["payload"], schemaVersion = 1): QueueMessage => ({
  id: "m-1",
  type: SMOKE_CHECK_MESSAGE_TYPE,
  schemaVersion,
  correlationId: "corr-1",
  payload,
});

describe("SmokeMessageHandler", () => {
  it("invokes the application SmokeCheck and logs the result", async () => {
    const { handler, lines } = setup();
    await handler.handle(message({ note: "ping" }));
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "smoke check completed",
        messageId: "m-1",
        note: "ping",
        checkedAt: "2026-09-27T10:00:00.000Z",
      }),
    );
  });

  it.each([
    ["a non-object payload", message("ping")],
    ["a missing note", message({ other: 1 })],
    ["an unknown schema version", message({ note: "x" }, 2)],
  ])("rejects %s", async (_label, invalid) => {
    const { handler } = setup();
    await expect(handler.handle(invalid)).rejects.toBeInstanceOf(ValidationError);
  });
});
