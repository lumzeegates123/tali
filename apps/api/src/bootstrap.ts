import "reflect-metadata";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import express from "express";
import { AppModule } from "./app.module.js";
import { IDEMPOTENT_REPLAYED_HEADER } from "./business/businesses.controller.js";
import type { ApiRuntime } from "./composition/api-runtime.js";
import { preRoutingErrorHandler } from "./errors/error-envelope.filter.js";
import { CORRELATION_HEADER, correlationMiddleware } from "./observability/correlation.js";
import { NestLoggerAdapter } from "./observability/logger.js";

/** Request bodies are small JSON documents; anything larger is refused before parsing. */
export const JSON_BODY_LIMIT = "16kb";

/** Builds the HTTP application from a composed runtime. Shared by main.ts and the tests. */
export async function createApiApplication(runtime: ApiRuntime): Promise<INestApplication<Server>> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(runtime), {
    logger: new NestLoggerAdapter(runtime.logger),
    abortOnError: false,
    bodyParser: false,
  });
  app.disable("x-powered-by");
  app.use(correlationMiddleware(runtime.logger));
  if (runtime.config.api.corsOrigins.length > 0) {
    // Browsers may read only exposed response headers cross-origin; the web
    // client shows the echoed correlation ID for support diagnostics and needs
    // to see when a keyed mutation was replayed.
    app.enableCors({
      origin: [...runtime.config.api.corsOrigins],
      exposedHeaders: [CORRELATION_HEADER, IDEMPOTENT_REPLAYED_HEADER],
    });
  }
  // Parser failures happen before routing, so they are mapped here with the filter's mapping.
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));
  app.use(preRoutingErrorHandler(runtime.logger));
  return app;
}
