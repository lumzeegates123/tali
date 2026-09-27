import { describe, expect, it } from "vitest";
import type { QueueMessage, QueueProvider } from "../../ports/queue-provider";

export interface QueueProviderContractSetup {
  readonly queue: QueueProvider;
  /** Moves the adapter's notion of time forward (a fake clock, or a real wait). */
  readonly advanceSeconds: (seconds: number) => Promise<void>;
}

function message(id: string): QueueMessage {
  return { id, type: "contract.test", schemaVersion: 1, correlationId: `corr-${id}`, payload: { id, n: [1, 2] } };
}

/** Behaviour every QueueProvider adapter must satisfy (at-least-once, visibility timeouts). */
export function describeQueueProviderContract(name: string, setup: () => Promise<QueueProviderContractSetup>): void {
  describe(`QueueProvider contract: ${name}`, () => {
    it("delivers a published message with its content intact", async () => {
      const { queue } = await setup();
      await queue.publish([message("m1")]);
      const [delivery, ...rest] = await queue.receive({ maxMessages: 10, visibilityTimeoutSeconds: 30 });
      expect(rest).toHaveLength(0);
      expect(delivery?.message).toEqual(message("m1"));
      expect(delivery?.deliveryCount).toBe(1);
    });

    it("hides an in-flight message until its visibility timeout, then redelivers it", async () => {
      const { queue, advanceSeconds } = await setup();
      await queue.publish([message("m1")]);
      await queue.receive({ maxMessages: 1, visibilityTimeoutSeconds: 5 });
      expect(await queue.receive({ maxMessages: 1, visibilityTimeoutSeconds: 5 })).toHaveLength(0);
      await advanceSeconds(6);
      const [redelivery] = await queue.receive({ maxMessages: 1, visibilityTimeoutSeconds: 5 });
      expect(redelivery?.message.id).toBe("m1");
      expect(redelivery?.deliveryCount).toBe(2);
    });

    it("never redelivers an acknowledged message", async () => {
      const { queue, advanceSeconds } = await setup();
      await queue.publish([message("m1")]);
      const [delivery] = await queue.receive({ maxMessages: 1, visibilityTimeoutSeconds: 1 });
      expect(delivery).toBeDefined();
      if (delivery !== undefined) await queue.acknowledge(delivery.receipt);
      await advanceSeconds(2);
      expect(await queue.receive({ maxMessages: 10, visibilityTimeoutSeconds: 1 })).toHaveLength(0);
    });

    it("makes a released message visible again after the delay", async () => {
      const { queue, advanceSeconds } = await setup();
      await queue.publish([message("m1")]);
      const [delivery] = await queue.receive({ maxMessages: 1, visibilityTimeoutSeconds: 60 });
      if (delivery !== undefined) await queue.release(delivery.receipt, 2);
      expect(await queue.receive({ maxMessages: 1, visibilityTimeoutSeconds: 60 })).toHaveLength(0);
      await advanceSeconds(3);
      expect(await queue.receive({ maxMessages: 1, visibilityTimeoutSeconds: 60 })).toHaveLength(1);
    });

    it("respects maxMessages without losing messages", async () => {
      const { queue } = await setup();
      await queue.publish([message("m1"), message("m2"), message("m3")]);
      const first = await queue.receive({ maxMessages: 2, visibilityTimeoutSeconds: 30 });
      const second = await queue.receive({ maxMessages: 2, visibilityTimeoutSeconds: 30 });
      expect(first).toHaveLength(2);
      expect(new Set([...first, ...second].map((delivery) => delivery.message.id))).toEqual(
        new Set(["m1", "m2", "m3"]),
      );
    });
  });
}
