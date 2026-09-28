import "reflect-metadata";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { WorkerRuntime } from "./composition/worker-runtime.js";
import { NestLoggerAdapter } from "./observability/logger.js";
import { WorkerModule } from "./worker.module.js";

/** Builds the worker's standalone context (no HTTP server). Shared by main.ts and the tests. */
export async function createWorkerContext(runtime: WorkerRuntime): Promise<INestApplicationContext> {
  await runtime.heartbeat.transition("starting");
  return NestFactory.createApplicationContext(WorkerModule.register(runtime), {
    logger: new NestLoggerAdapter(runtime.logger),
    abortOnError: false,
  });
}
