import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { parseCorrelationId, type QueueProvider, type ReceivedMessage } from "@tali/application";
import type { ServerConfig } from "@tali/config/server";
import { HEARTBEAT, LOGGER, MESSAGE_HANDLERS, QUEUE_PROVIDER, SERVER_CONFIG } from "../composition/tokens.js";
import type { MessageHandler } from "../handlers/message-handler.js";
import type { Heartbeat } from "../health/heartbeat.js";
import { runWithCorrelationId } from "../observability/correlation-context.js";
import type { Logger } from "../observability/logger.js";

const BATCH_SIZE = 10;
const VISIBILITY_TIMEOUT_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 60;

/**
 * Polls the QueueProvider, dispatches each message to the handler for its
 * type, acknowledges on success and releases (with backoff) on failure.
 * Delivery is at-least-once. Graceful shutdown: stop polling, let the batch in
 * flight finish, then report `stopped`.
 */
@Injectable()
export class MessageLoop implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  readonly #queue: QueueProvider;
  readonly #handlers: ReadonlyMap<string, MessageHandler>;
  readonly #heartbeat: Heartbeat;
  readonly #logger: Logger;
  readonly #pollIntervalMs: number;
  #running = false;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> = Promise.resolve();

  constructor(
    @Inject(QUEUE_PROVIDER) queue: QueueProvider,
    @Inject(MESSAGE_HANDLERS) handlers: readonly MessageHandler[],
    @Inject(HEARTBEAT) heartbeat: Heartbeat,
    @Inject(LOGGER) logger: Logger,
    @Inject(SERVER_CONFIG) config: ServerConfig,
  ) {
    this.#queue = queue;
    this.#handlers = new Map(handlers.map((handler) => [handler.type, handler]));
    this.#heartbeat = heartbeat;
    this.#logger = logger;
    this.#pollIntervalMs = config.worker.pollIntervalMs;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.#running = true;
    await this.#heartbeat.transition("ready");
    this.#logger.info("worker ready", { handlers: [...this.#handlers.keys()] });
    this.#schedule(0);
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.#logger.info("worker stopping", { signal });
    this.#running = false;
    clearTimeout(this.#timer);
    await this.#heartbeat.transition("stopping");
    await this.#inFlight;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#heartbeat.transition("stopped");
    this.#logger.info("worker stopped", this.#heartbeat.counts);
  }

  /** Runs one receive-and-dispatch cycle. Exposed for tests. */
  async pollOnce(): Promise<number> {
    const received = await this.#queue.receive({
      maxMessages: BATCH_SIZE,
      visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
    });
    for (const delivery of received) {
      await this.#dispatch(delivery);
    }
    return received.length;
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.#inFlight = this.#tick();
    }, delayMs);
  }

  async #tick(): Promise<void> {
    let received = 0;
    try {
      received = await this.pollOnce();
    } catch (error) {
      this.#logger.error("queue receive failed", { error });
    }
    this.#schedule(received > 0 ? 0 : this.#pollIntervalMs);
  }

  async #dispatch(delivery: ReceivedMessage): Promise<void> {
    const { message, receipt, deliveryCount } = delivery;
    let correlationId;
    try {
      correlationId = parseCorrelationId(message.correlationId);
    } catch {
      correlationId = parseCorrelationId(message.id);
    }
    await runWithCorrelationId(correlationId, async () => {
      const handler = this.#handlers.get(message.type);
      try {
        if (handler === undefined) throw new Error(`no handler for message type ${message.type}`);
        await handler.handle(message);
        await this.#queue.acknowledge(receipt);
        this.#heartbeat.recordProcessed();
      } catch (error) {
        const delaySeconds = Math.min(2 ** deliveryCount, MAX_RETRY_DELAY_SECONDS);
        this.#heartbeat.recordFailed();
        this.#logger.error("message handling failed; released for retry", {
          messageId: message.id,
          type: message.type,
          deliveryCount,
          retryInSeconds: delaySeconds,
          error,
        });
        await this.#queue.release(receipt, delaySeconds);
      }
    });
  }
}
