import { type DynamicModule, Module } from "@nestjs/common";
import type { WorkerRuntime } from "./composition/worker-runtime.js";
import { CLOCK, HEARTBEAT, LOGGER, MESSAGE_HANDLERS, QUEUE_PROVIDER, SERVER_CONFIG } from "./composition/tokens.js";
import { MessageLoop } from "./processing/message-loop.js";

/** Root module of the worker's standalone application context (no HTTP server). */
@Module({})
export class WorkerModule {
  static register(runtime: WorkerRuntime): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: SERVER_CONFIG, useValue: runtime.config },
        { provide: LOGGER, useValue: runtime.logger },
        { provide: CLOCK, useValue: runtime.clock },
        { provide: QUEUE_PROVIDER, useValue: runtime.queue },
        { provide: MESSAGE_HANDLERS, useValue: runtime.handlers },
        { provide: HEARTBEAT, useValue: runtime.heartbeat },
        MessageLoop,
      ],
    };
  }
}
