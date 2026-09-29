import "reflect-metadata";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import type { ApiRuntime } from "./composition/api-runtime.js";
import { CORRELATION_HEADER, correlationMiddleware } from "./observability/correlation.js";
import { NestLoggerAdapter } from "./observability/logger.js";

/** Builds the HTTP application from a composed runtime. Shared by main.ts and the tests. */
export async function createApiApplication(runtime: ApiRuntime): Promise<INestApplication<Server>> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(runtime), {
    logger: new NestLoggerAdapter(runtime.logger),
    abortOnError: false,
  });
  app.disable("x-powered-by");
  app.use(correlationMiddleware(runtime.logger));
  if (runtime.config.api.corsOrigins.length > 0) {
    // Browsers may read only exposed response headers cross-origin; the web
    // client shows the echoed correlation ID for support diagnostics.
    app.enableCors({ origin: [...runtime.config.api.corsOrigins], exposedHeaders: [CORRELATION_HEADER] });
  }
  return app;
}
