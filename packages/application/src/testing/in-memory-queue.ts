import { ValidationError } from "../errors/application-error";
import type { Clock } from "../ports/clock";
import type {
  DeliveryReceipt,
  JsonValue,
  QueueMessage,
  QueueProvider,
  ReceivedMessage,
  ReceiveOptions,
} from "../ports/queue-provider";

interface Entry {
  readonly message: QueueMessage;
  visibleAtMs: number;
  deliveryCount: number;
  receipt: DeliveryReceipt | undefined;
}

function cloneMessage(message: QueueMessage): QueueMessage {
  return Object.freeze({ ...message, payload: JSON.parse(JSON.stringify(message.payload)) as JsonValue });
}

/**
 * An in-process queue with visibility timeouts and at-least-once delivery.
 * Only for unit tests, port contract tests and single-process worker smoke
 * tests; it is never a channel between the API and worker processes.
 */
export class InMemoryQueue implements QueueProvider {
  readonly #clock: Clock;
  #entries: Entry[] = [];
  #receiptCounter = 0;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Number of messages not yet acknowledged (visible or in flight). */
  get size(): number {
    return this.#entries.length;
  }

  async publish(messages: readonly QueueMessage[]): Promise<void> {
    const now = this.#clock.now().getTime();
    for (const message of messages) {
      this.#entries.push({ message: cloneMessage(message), visibleAtMs: now, deliveryCount: 0, receipt: undefined });
    }
  }

  async receive(options: ReceiveOptions): Promise<readonly ReceivedMessage[]> {
    if (!Number.isSafeInteger(options.maxMessages) || options.maxMessages < 1) {
      throw new ValidationError("maxMessages must be a positive integer");
    }
    const now = this.#clock.now().getTime();
    const received: ReceivedMessage[] = [];
    for (const entry of this.#entries) {
      if (received.length >= options.maxMessages) break;
      if (entry.visibleAtMs > now) continue;
      this.#receiptCounter += 1;
      entry.receipt = `memory-receipt-${this.#receiptCounter}` as DeliveryReceipt;
      entry.deliveryCount += 1;
      entry.visibleAtMs = now + options.visibilityTimeoutSeconds * 1000;
      received.push({
        message: cloneMessage(entry.message),
        receipt: entry.receipt,
        deliveryCount: entry.deliveryCount,
      });
    }
    return received;
  }

  async acknowledge(receipt: DeliveryReceipt): Promise<void> {
    this.#entries = this.#entries.filter((entry) => entry.receipt !== receipt);
  }

  async release(receipt: DeliveryReceipt, delaySeconds: number): Promise<void> {
    const entry = this.#entries.find((candidate) => candidate.receipt === receipt);
    if (entry !== undefined) {
      entry.receipt = undefined;
      entry.visibleAtMs = this.#clock.now().getTime() + delaySeconds * 1000;
    }
  }
}
