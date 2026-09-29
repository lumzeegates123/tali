import type { ObjectKey } from "../ports/object-storage-provider.js";
import { describe, expect, it } from "vitest";
import {
  FixedClock,
  InMemoryObjectStorage,
  InMemoryQueue,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
} from "./index.js";

describe("SequentialIdGenerator", () => {
  it("is deterministic across instances", () => {
    const a = new SequentialIdGenerator();
    const b = new SequentialIdGenerator();
    expect(a.newId("Business")).toBe(b.newId("Business"));
    expect(a.issued).toEqual([{ entity: "Business", id: b.issued[0]?.id }]);
  });
});

describe("FixedClock", () => {
  it("moves only forward and only when told to", () => {
    const clock = new FixedClock("2026-09-27T00:00:00Z");
    clock.advanceBySeconds(90);
    expect(clock.now().toISOString()).toBe("2026-09-27T00:01:30.000Z");
    expect(() => {
      clock.advanceBy(-1);
    }).toThrow();
    expect(() => new FixedClock("not a date")).toThrow();
  });
});

describe("InMemoryObjectStorage uploads", () => {
  const key = "business/01/receipt.jpg" as ObjectKey;

  it("accepts an upload only through an issued, unexpired target within the size limit", async () => {
    const clock = new FixedClock("2026-09-27T00:00:00Z");
    const storage = new InMemoryObjectStorage(clock);
    expect(() => {
      storage.completeUpload(key, Uint8Array.from([1]));
    }).toThrow(/no upload target/);

    await storage.createUploadTarget({ key, contentType: "image/jpeg", maxBytes: 2, expiresInSeconds: 60 });
    expect(() => {
      storage.completeUpload(key, Uint8Array.from([1, 2, 3]));
    }).toThrow(/size/);

    clock.advanceBySeconds(61);
    expect(() => {
      storage.completeUpload(key, Uint8Array.from([1]));
    }).toThrow(/expired/);
  });

  it("stores a completed upload with the declared content type", async () => {
    const clock = new FixedClock("2026-09-27T00:00:00Z");
    const storage = new InMemoryObjectStorage(clock);
    await storage.createUploadTarget({ key, contentType: "image/jpeg", maxBytes: 10, expiresInSeconds: 60 });
    storage.completeUpload(key, Uint8Array.from([1, 2]));
    expect(await storage.getObjectInfo(key)).toEqual({ key, byteSize: 2, contentType: "image/jpeg" });
  });
});

describe("InMemoryQueue", () => {
  it("isolates stored messages from caller mutation", async () => {
    const queue = new InMemoryQueue(new FixedClock("2026-09-27T00:00:00Z"));
    const payload = { items: [1] };
    await queue.publish([{ id: "m1", type: "t", schemaVersion: 1, correlationId: "c", payload }]);
    payload.items.push(2);
    const [delivery] = await queue.receive({ maxMessages: 1, visibilityTimeoutSeconds: 1 });
    expect(delivery?.message.payload).toEqual({ items: [1] });
    expect(queue.size).toBe(1);
  });
});

describe("InMemoryUnitOfWork", () => {
  it("records commits and rollbacks", async () => {
    const unitOfWork = new InMemoryUnitOfWork();
    await unitOfWork.run(async () => "ok");
    await expect(
      unitOfWork.run(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    expect([unitOfWork.commits, unitOfWork.rollbacks]).toEqual([1, 1]);
  });

  it("restores enlisted participants when a run fails", async () => {
    let state = ["initial"];
    const unitOfWork = new InMemoryUnitOfWork().enlist({
      captureState: () => {
        const saved = [...state];
        return () => {
          state = saved;
        };
      },
    });
    await unitOfWork.run(async () => {
      state.push("committed");
    });
    await expect(
      unitOfWork.run(async () => {
        state.push("rolled back");
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    expect(state).toEqual(["initial", "committed"]);
  });

  it("rejects a scope used after its run finished", async () => {
    const unitOfWork = new InMemoryUnitOfWork();
    const scope = await unitOfWork.run(async (active) => {
      unitOfWork.assertActive(active);
      return active;
    });
    expect(() => {
      unitOfWork.assertActive(scope);
    }).toThrow(/outside its unit of work/);
  });
});
