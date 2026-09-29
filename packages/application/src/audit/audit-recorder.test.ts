import { parseId } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { parseCorrelationId } from "../context/business-context.js";
import { FixedClock } from "../testing/fixed-clock.js";
import { InMemoryAuditWriter } from "../testing/in-memory-audit-writer.js";
import { InMemoryUnitOfWork } from "../testing/in-memory-unit-of-work.js";
import { SequentialIdGenerator } from "../testing/sequential-id-generator.js";
import { defineAuditAction, defineAuditRegistry } from "./audit-action.js";
import { auditField, AuditPayloadError } from "./audit-payload.js";
import { AuditRecorder } from "./audit-recorder.js";

const businessAction = defineAuditAction({
  name: "example.changed",
  stream: "business",
  entityType: "business",
  payloadSchemaVersion: 2,
  fields: { flag: auditField.boolean() },
});
const platformAction = defineAuditAction({
  name: "example.registered",
  stream: "platform",
  entityType: "user",
  payloadSchemaVersion: 1,
  fields: { flag: auditField.boolean() },
});
const unregistered = defineAuditAction({
  name: "example.unregistered",
  stream: "business",
  entityType: "business",
  payloadSchemaVersion: 1,
  fields: { flag: auditField.boolean() },
});

const businessId = parseId("Business", "01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f");
const userId = parseId("User", "01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e60");
const membershipId = parseId("Membership", "01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e61");

function setup() {
  const unitOfWork = new InMemoryUnitOfWork();
  const writer = new InMemoryAuditWriter({ unitOfWork });
  const recorder = new AuditRecorder({
    registry: defineAuditRegistry([businessAction, platformAction]),
    writer,
    clock: new FixedClock("2026-09-29T08:00:00.000Z"),
    ids: new SequentialIdGenerator(),
  });
  const event = {
    businessId,
    entityId: businessId,
    actor: { type: "user", userId, membershipId },
    sourceChannel: "web",
    correlationId: parseCorrelationId("req-1"),
    payload: { flag: true },
  } as const;
  return { unitOfWork, writer, recorder, event };
}

describe("AuditRecorder", () => {
  it("writes a business record with the envelope and validated payload", async () => {
    const { unitOfWork, writer, recorder, event } = setup();
    await unitOfWork.run((scope) =>
      recorder.recordBusinessEvent(scope, businessAction, { ...event, reason: "because" }),
    );
    expect(writer.businessRecords).toHaveLength(1);
    expect(writer.businessRecords[0]).toMatchObject({
      action: "example.changed",
      entityType: "business",
      entityId: businessId,
      businessId,
      payload: { flag: true },
      payloadSchemaVersion: 2,
      reason: "because",
      occurredAt: new Date("2026-09-29T08:00:00.000Z"),
    });
  });

  it("writes a platform record without a business", async () => {
    const { unitOfWork, writer, recorder } = setup();
    await unitOfWork.run((scope) =>
      recorder.recordPlatformEvent(scope, platformAction, {
        subjectUserId: userId,
        entityId: userId,
        actor: { type: "user", userId },
        sourceChannel: "mobile",
        correlationId: parseCorrelationId("req-2"),
        payload: { flag: false },
      }),
    );
    expect(writer.platformRecords).toHaveLength(1);
    expect(writer.platformRecords[0]).not.toHaveProperty("businessId");
  });

  it("rejects an unregistered action and writes nothing", async () => {
    const { unitOfWork, writer, recorder, event } = setup();
    await expect(unitOfWork.run((scope) => recorder.recordBusinessEvent(scope, unregistered, event))).rejects.toThrow(
      /not registered/,
    );
    expect(writer.all).toHaveLength(0);
  });

  it("rejects an action used on the wrong stream", async () => {
    const { unitOfWork, recorder, event } = setup();
    await expect(
      unitOfWork.run((scope) =>
        // @ts-expect-error: a platform action cannot be recorded as a business event
        recorder.recordBusinessEvent(scope, platformAction, event),
      ),
    ).rejects.toThrow(/platform stream/);
  });

  it("rejects an invalid payload at runtime and writes nothing", async () => {
    const { unitOfWork, writer, recorder, event } = setup();
    const payload = { flag: true, extra: "x" } as unknown as { flag: boolean };
    await expect(
      unitOfWork.run((scope) => recorder.recordBusinessEvent(scope, businessAction, { ...event, payload })),
    ).rejects.toThrow(AuditPayloadError);
    expect(writer.all).toHaveLength(0);
  });

  it.each(["", "   ", "x".repeat(501), "\uDC00"])("rejects the reason %j", async (reason) => {
    const { unitOfWork, recorder, event } = setup();
    await expect(
      unitOfWork.run((scope) => recorder.recordBusinessEvent(scope, businessAction, { ...event, reason })),
    ).rejects.toThrow(AuditPayloadError);
  });

  it("accepts a 500-character reason", async () => {
    const { unitOfWork, writer, recorder, event } = setup();
    await unitOfWork.run((scope) =>
      recorder.recordBusinessEvent(scope, businessAction, { ...event, reason: "é".repeat(500) }),
    );
    expect(writer.businessRecords).toHaveLength(1);
  });
});
