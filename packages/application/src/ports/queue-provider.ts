/**
 * An asynchronous message. Payloads are JSON-compatible and carry only
 * references and small data; delivery is at-least-once, so consumers dedupe
 * by `id`.
 */
export interface QueueMessage {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly correlationId: string;
  readonly payload: JsonValue;
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

declare const receiptBrand: unique symbol;

/** An opaque handle for one delivery of a message. */
export type DeliveryReceipt = string & { readonly [receiptBrand]: true };

export interface ReceivedMessage {
  readonly message: QueueMessage;
  readonly receipt: DeliveryReceipt;
  /** 1 for the first delivery; increases on redelivery. */
  readonly deliveryCount: number;
}

export interface ReceiveOptions {
  readonly maxMessages: number;
  /** How long received messages stay hidden from other consumers. */
  readonly visibilityTimeoutSeconds: number;
}

/**
 * Deployed transport is SQS (ADR-001). Locally, API-to-worker work goes
 * through the PostgreSQL outbox; an in-memory implementation is only for tests
 * and single-process smoke tests (ADR-002 section 7).
 */
export interface QueueProvider {
  publish(messages: readonly QueueMessage[]): Promise<void>;
  receive(options: ReceiveOptions): Promise<readonly ReceivedMessage[]>;
  /** Marks a delivery as processed; the message is not delivered again. */
  acknowledge(receipt: DeliveryReceipt): Promise<void>;
  /** Returns a delivery to the queue, visible again after the delay. */
  release(receipt: DeliveryReceipt, delaySeconds: number): Promise<void>;
}
