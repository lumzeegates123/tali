import type { QueueMessage } from "@tali/application";

/**
 * A worker message handler: validates the message and invokes an application
 * use case. Handlers never import packages/database or integration adapters;
 * the composition root wires those into the use cases (ADR-002 section 7).
 */
export interface MessageHandler {
  readonly type: string;
  handle(message: QueueMessage): Promise<void>;
}
