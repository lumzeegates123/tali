import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import type { LivenessResponse, ReadinessResponse } from "@tali/shared";
import type { Response } from "express";
import { DATABASE_HEALTH, LOGGER } from "../composition/tokens.js";
import type { Logger } from "../observability/logger.js";

/** The slice of the database the health check needs. */
export interface DatabaseHealth {
  ping(): Promise<void>;
}

const READINESS_TIMEOUT_MS = 2_000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

@Controller("health")
export class HealthController {
  readonly #database: DatabaseHealth;
  readonly #logger: Logger;

  constructor(@Inject(DATABASE_HEALTH) database: DatabaseHealth, @Inject(LOGGER) logger: Logger) {
    this.#database = database;
    this.#logger = logger;
  }

  /** The process is up. Never checks dependencies, so it cannot cascade failures. */
  @Get("live")
  live(): LivenessResponse {
    return { status: "ok" };
  }

  /** Ready to serve: PostgreSQL answers within the timeout. 503 otherwise. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessResponse> {
    try {
      await withTimeout(this.#database.ping(), READINESS_TIMEOUT_MS);
      return { status: "ready", checks: { database: "up" } };
    } catch (error) {
      this.#logger.warn("readiness check failed", { dependency: "database", error });
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: "not_ready", checks: { database: "down" } };
    }
  }
}
