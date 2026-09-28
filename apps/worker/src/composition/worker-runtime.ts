import { randomUUID } from "node:crypto";
import { createSmokeCheck, SMOKE_CHECK_MESSAGE_TYPE, type Clock, type QueueProvider } from "@tali/application";
import { InMemoryQueue } from "@tali/application/testing";
import type { ServerConfig } from "@tali/config/server";
import type { MessageHandler } from "../handlers/message-handler.js";
import { SmokeMessageHandler } from "../handlers/system/smoke.handler.js";
import { Heartbeat } from "../health/heartbeat.js";
import { JsonLogger, type Logger } from "../observability/logger.js";

/**
 * Everything the worker process composes, built once at startup. The worker
 * composition root is the only worker code that constructs adapters; handlers
 * receive use cases.
 */
export interface WorkerRuntime {
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly queue: QueueProvider;
  readonly handlers: readonly MessageHandler[];
  readonly heartbeat: Heartbeat;
}

export const systemClock: Clock = { now: () => new Date() };

export class CompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositionError";
  }
}

/**
 * Only the in-memory queue exists in Wave B. It is in-process: it lets the
 * worker smoke-test itself, and it does NOT carry messages from the API
 * process. Cross-process work arrives later through the PostgreSQL outbox
 * (locally) and SQS (deployed).
 */
function composeQueue(config: ServerConfig, clock: Clock): QueueProvider {
  switch (config.queue.provider) {
    case "memory":
      return new InMemoryQueue(clock);
    case "sqs":
      throw new CompositionError("QUEUE_PROVIDER=sqs is not implemented yet; no AWS integration exists in Wave B");
  }
}

export interface WorkerRuntimeOverrides {
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly queue?: QueueProvider;
  readonly handlers?: readonly MessageHandler[];
}

export function createWorkerRuntime(config: ServerConfig, overrides: WorkerRuntimeOverrides = {}): WorkerRuntime {
  const logger =
    overrides.logger ??
    new JsonLogger({ service: `${config.observability.serviceName}-worker`, level: config.observability.logLevel });
  const clock = overrides.clock ?? systemClock;
  const queue = overrides.queue ?? composeQueue(config, clock);
  const handlers = overrides.handlers ?? [new SmokeMessageHandler(createSmokeCheck({ clock }), logger)];
  const heartbeat = new Heartbeat({ file: config.worker.heartbeatFile, intervalMs: config.worker.heartbeatIntervalMs });
  return { config, logger, clock, queue, handlers, heartbeat };
}

/** Publishes one smoke-check message to the worker's own in-process queue. */
export async function publishSmokeMessage(runtime: WorkerRuntime, note = "worker smoke check"): Promise<string> {
  const id = randomUUID();
  await runtime.queue.publish([
    { id, type: SMOKE_CHECK_MESSAGE_TYPE, schemaVersion: 1, correlationId: `smoke-${id}`, payload: { note } },
  ]);
  return id;
}
