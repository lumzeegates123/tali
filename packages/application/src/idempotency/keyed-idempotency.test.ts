import type { JsonValue } from "../ports/queue-provider.js";
import { parseId, parseUuid } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  ValidationError,
} from "../errors/application-error.js";
import { FakeFingerprintHasher } from "../testing/fake-fingerprint-hasher.js";
import { FixedClock } from "../testing/fixed-clock.js";
import { InMemoryUnitOfWork } from "../testing/in-memory-unit-of-work.js";
import { InMemoryUserIdempotencyStore } from "../testing/in-memory-user-idempotency-store.js";
import { SequentialIdGenerator } from "../testing/sequential-id-generator.js";
import { canonicalCommandEncoding } from "./canonical-command.js";
import { requireIdempotencyKey } from "./idempotency-key.js";
import type { IdempotentResultCodec } from "./keyed-idempotency.js";
import { KeyedIdempotency } from "./keyed-idempotency.js";

const userId = parseId("User", "01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e60");
const otherUser = parseId("User", "01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e61");
const key = requireIdempotencyKey("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4eaa");
const resourceId = parseUuid("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4ebb");
const codec: IdempotentResultCodec<string> = {
  encode: (value) => value,
  decode: (stored: JsonValue) => {
    if (typeof stored !== "string") throw new Error("expected a string result");
    return stored;
  },
};

function setup() {
  const clock = new FixedClock("2026-09-29T08:00:00.000Z");
  const ids = new SequentialIdGenerator();
  const unitOfWork = new InMemoryUnitOfWork();
  const store = new InMemoryUserIdempotencyStore({ unitOfWork });
  const hasher = new FakeFingerprintHasher();
  const idempotency = new KeyedIdempotency({ store, clock, ids });
  const applied: string[] = [];
  const run = async (value: number, options: { user?: typeof userId; operation?: string; fail?: boolean } = {}) => {
    const command = canonicalCommandEncoding({
      operation: options.operation ?? "example.create.v1",
      commandSchemaVersion: 1,
      command: { value },
    });
    const fingerprint = await hasher.fingerprint(command);
    return unitOfWork.run((scope) =>
      idempotency.runUserScoped(scope, {
        userId: options.user ?? userId,
        key,
        command,
        fingerprint,
        resourceType: "example",
        codec,
        plan: async () => ({
          result: `result-${value}`,
          resourceId,
          apply: async () => {
            applied.push(`result-${value}`);
            if (options.fail === true) throw new Error("write failed");
          },
        }),
      }),
    );
  };
  return { store, run, applied, clock };
}

describe("idempotency key", () => {
  it("is required", () => {
    expect(() => requireIdempotencyKey(undefined)).toThrow(IdempotencyKeyRequiredError);
  });

  it("must be a UUID of any version", () => {
    expect(() => requireIdempotencyKey("not-a-uuid")).toThrow(ValidationError);
    expect(requireIdempotencyKey("3b241101-e2bb-4255-8caf-4136c566a962")).toBe("3b241101-e2bb-4255-8caf-4136c566a962");
  });
});

describe("KeyedIdempotency", () => {
  it("applies the first request and stores the result with 30-day retention", async () => {
    const { store, run, applied } = setup();
    expect(await run(1)).toEqual({ result: "result-1", replayed: false });
    expect(applied).toEqual(["result-1"]);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      userId,
      operation: "example.create.v1",
      idempotencyKey: key,
      result: "result-1",
      resourceType: "example",
      resourceId,
      expiresAt: new Date("2026-10-29T08:00:00.000Z"),
    });
  });

  it("replays the stored result for the same command without applying again", async () => {
    const { run, applied } = setup();
    await run(1);
    expect(await run(1)).toEqual({ result: "result-1", replayed: true });
    expect(applied).toEqual(["result-1"]);
  });

  it("rejects the same key with a different command", async () => {
    const { run, applied } = setup();
    await run(1);
    await expect(run(2)).rejects.toThrow(IdempotencyKeyReusedError);
    expect(applied).toEqual(["result-1"]);
  });

  it("rejects the same key for a different operation", async () => {
    const { run } = setup();
    await run(1);
    await expect(run(1, { operation: "example.other.v1" })).rejects.toThrow(IdempotencyKeyReusedError);
  });

  it("scopes keys by user", async () => {
    const { run, applied } = setup();
    await run(1);
    expect(await run(2, { user: otherUser })).toEqual({ result: "result-2", replayed: false });
    expect(applied).toEqual(["result-1", "result-2"]);
  });

  it("leaves no record when the mutation fails, so a retry applies", async () => {
    const { store, run, applied } = setup();
    await expect(run(1, { fail: true })).rejects.toThrow("write failed");
    expect(store.records).toHaveLength(0);
    expect(await run(1)).toEqual({ result: "result-1", replayed: false });
    expect(applied).toEqual(["result-1", "result-1"]);
  });

  it("replays when a concurrent request claimed the key first, without applying", async () => {
    const { store, run, applied } = setup();
    store.beforeInsert = (record) => {
      store.put({ ...record, result: "winner" });
    };
    expect(await run(1)).toEqual({ result: "winner", replayed: true });
    expect(applied).toEqual([]);
  });

  it("rejects when a concurrent request claimed the key with a different command", async () => {
    const { store, run } = setup();
    store.beforeInsert = (record) => {
      store.put({ ...record, fingerprint: { version: 1, digest: new Uint8Array(32) } });
    };
    await expect(run(1)).rejects.toThrow(IdempotencyKeyReusedError);
  });

  it("refuses retention shorter than 30 days", () => {
    const clock = new FixedClock("2026-09-29T08:00:00.000Z");
    expect(
      () =>
        new KeyedIdempotency({
          store: new InMemoryUserIdempotencyStore(),
          clock,
          ids: new SequentialIdGenerator(),
          retentionDays: 29,
        }),
    ).toThrow(/30 days/);
  });
});
