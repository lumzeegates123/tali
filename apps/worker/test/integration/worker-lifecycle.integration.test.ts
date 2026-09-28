import type { INestApplicationContext } from "@nestjs/common";
import type { QueueMessage } from "@tali/application";
import { InMemoryQueue } from "@tali/application/testing";
import { loadServerConfig } from "@tali/config/server";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerContext } from "../../src/bootstrap.js";
import { createWorkerRuntime, publishSmokeMessage, type WorkerRuntime } from "../../src/composition/worker-runtime.js";
import type { MessageHandler } from "../../src/handlers/message-handler.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { MessageLoop } from "../../src/processing/message-loop.js";

const TEST_ENV = {
  TALI_ENV: "test",
  DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused_test",
  IDENTITY_PROVIDER: "fake",
  OBJECT_STORAGE_PROVIDER: "memory",
  QUEUE_PROVIDER: "memory",
  WORKER_POLL_INTERVAL_MS: "20",
};

const realClock = { now: () => new Date() };

function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error("condition not met in time"));
      else setTimeout(check, 10);
    };
    check();
  });
}

describe("worker lifecycle (in-process, standalone Nest context)", () => {
  let context: INestApplicationContext | undefined;
  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  async function start(handlers?: readonly MessageHandler[]) {
    const logs: Record<string, unknown>[] = [];
    const logger = new JsonLogger({
      service: "t",
      level: "debug",
      sink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
    });
    const queue = new InMemoryQueue(realClock);
    const runtime: WorkerRuntime = createWorkerRuntime(loadServerConfig(TEST_ENV), {
      logger,
      clock: realClock,
      queue,
      ...(handlers === undefined ? {} : { handlers }),
    });
    context = await createWorkerContext(runtime);
    return { runtime, queue, logs, context };
  }

  it("starts a standalone context with no HTTP server and reports ready", async () => {
    const { runtime, context: ctx, logs } = await start();
    expect(runtime.heartbeat.state).toBe("ready");
    expect(() => (ctx as unknown as { getHttpServer: () => unknown }).getHttpServer()).toThrow();
    expect(logs).toContainEqual(expect.objectContaining({ msg: "worker ready", handlers: ["system.smoke-check"] }));
  });

  it("processes a smoke message through the application SmokeCheck and acknowledges it", async () => {
    const { runtime, queue, logs } = await start();
    const id = await publishSmokeMessage(runtime, "hello worker");
    await waitFor(() => queue.size === 0);
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: "smoke check completed",
        messageId: id,
        note: "hello worker",
        correlationId: `smoke-${id}`,
      }),
    );
    expect(runtime.heartbeat.counts).toEqual({ processed: 1, failed: 0 });
  });

  it("releases a failed message for retry instead of acknowledging it", async () => {
    const failing: MessageHandler = {
      type: "test.always-fails",
      async handle() {
        throw new Error("handler failure");
      },
    };
    const { runtime, queue, logs } = await start([failing]);
    const message: QueueMessage = {
      id: "f-1",
      type: "test.always-fails",
      schemaVersion: 1,
      correlationId: "f-1",
      payload: null,
    };
    await queue.publish([message]);
    await waitFor(() => runtime.heartbeat.counts.failed === 1);
    expect(queue.size).toBe(1);
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: "message handling failed; released for retry",
        messageId: "f-1",
        deliveryCount: 1,
        retryInSeconds: 2,
      }),
    );
  });

  it("releases messages of unknown type", async () => {
    const { runtime, queue } = await start();
    await queue.publish([{ id: "u-1", type: "unknown.type", schemaVersion: 1, correlationId: "u-1", payload: null }]);
    await waitFor(() => runtime.heartbeat.counts.failed === 1);
    expect(queue.size).toBe(1);
  });

  it("shuts down gracefully: in-flight work finishes, then the worker reports stopped", async () => {
    let release!: () => void;
    const finished: string[] = [];
    const slow: MessageHandler = {
      type: "test.slow",
      async handle(message) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        finished.push(message.id);
      },
    };
    const { runtime, queue, context: ctx, logs } = await start([slow]);
    await queue.publish([{ id: "s-1", type: "test.slow", schemaVersion: 1, correlationId: "s-1", payload: null }]);
    await waitFor(() => typeof release === "function");

    const closing = ctx.close();
    context = undefined;
    await waitFor(() => runtime.heartbeat.state === "stopping");
    expect(finished).toEqual([]);
    release();
    await closing;

    expect(finished).toEqual(["s-1"]);
    expect(queue.size).toBe(0);
    expect(runtime.heartbeat.state).toBe("stopped");
    const order = logs
      .map((entry) => entry["msg"])
      .filter((msg) => msg === "worker stopping" || msg === "worker stopped");
    expect(order).toEqual(["worker stopping", "worker stopped"]);
  });

  it("the loop is resolvable from the context (DI wiring with explicit tokens)", async () => {
    const { context: ctx } = await start();
    expect(ctx.get(MessageLoop)).toBeInstanceOf(MessageLoop);
  });
});
