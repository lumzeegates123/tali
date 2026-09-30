import { randomUUID } from "node:crypto";
import { parseCorrelationId, type CorrelationId } from "@tali/application";
import type { NextFunction, Request, Response } from "express";
import type { TaliRequest } from "../http/request-context.js";
import { runWithCorrelationId } from "./correlation-context.js";
import type { Logger } from "./logger.js";

export const CORRELATION_HEADER = "x-correlation-id";

/** Accepts a well-formed inbound correlation ID; otherwise issues a new one. */
export function resolveCorrelationId(inbound: string | undefined): CorrelationId {
  if (inbound !== undefined) {
    try {
      return parseCorrelationId(inbound);
    } catch {
      // Malformed or oversized inbound IDs are replaced, never echoed.
    }
  }
  return parseCorrelationId(randomUUID());
}

/**
 * Express middleware: binds a correlation ID to the request (and its async
 * context, which stamps every log line), echoes it in the response header, and
 * logs one line per completed request. Guards pass it into the resolved
 * contexts, so it reaches use cases and audit records.
 */
export function correlationMiddleware(logger: Logger) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const correlationId = resolveCorrelationId(request.header(CORRELATION_HEADER));
    (request as TaliRequest).correlationId = correlationId;
    response.setHeader(CORRELATION_HEADER, correlationId);
    const started = process.hrtime.bigint();
    response.on("finish", () => {
      const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
      runWithCorrelationId(correlationId, () => {
        logger.info("request completed", {
          method: request.method,
          path: request.path,
          status: response.statusCode,
          durationMs,
        });
      });
    });
    runWithCorrelationId(correlationId, next);
  };
}
