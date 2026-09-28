import {
  parseCorrelationId,
  SMOKE_CHECK_MESSAGE_TYPE,
  type QueueMessage,
  type SmokeCheck,
  ValidationError,
} from "@tali/application";
import type { Logger } from "../../observability/logger.js";
import type { MessageHandler } from "../message-handler.js";

/**
 * Harmless smoke handler (Wave B): proves the worker receives a message and
 * reaches the application layer through the SmokeCheck contract. No side
 * effects beyond a log line.
 */
export class SmokeMessageHandler implements MessageHandler {
  readonly type = SMOKE_CHECK_MESSAGE_TYPE;
  readonly #smokeCheck: SmokeCheck;
  readonly #logger: Logger;

  constructor(smokeCheck: SmokeCheck, logger: Logger) {
    this.#smokeCheck = smokeCheck;
    this.#logger = logger;
  }

  async handle(message: QueueMessage): Promise<void> {
    const payload = message.payload;
    if (message.schemaVersion !== 1 || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ValidationError("unsupported smoke-check message");
    }
    const note = (payload as Readonly<Record<string, unknown>>)["note"];
    if (typeof note !== "string") {
      throw new ValidationError("smoke-check payload requires a string note");
    }
    const result = await this.#smokeCheck.execute({ correlationId: parseCorrelationId(message.correlationId), note });
    this.#logger.info("smoke check completed", {
      messageId: message.id,
      note: result.note,
      checkedAt: result.checkedAt.toISOString(),
    });
  }
}
