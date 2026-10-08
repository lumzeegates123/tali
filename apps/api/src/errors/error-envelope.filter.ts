import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Inject } from "@nestjs/common";
import { ApplicationError, type ApplicationErrorCode, ValidationError } from "@tali/application";
import type { ErrorEnvelope } from "@tali/shared";
import type { NextFunction, Request, Response } from "express";
import { LOGGER } from "../composition/tokens.js";
import type { Logger } from "../observability/logger.js";

const APPLICATION_STATUS: Record<ApplicationErrorCode, number> = {
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  PERMISSION_DENIED: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  LOCATION_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,
  DEPENDENCY_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  USER_NOT_REGISTERED: HttpStatus.FORBIDDEN,
  USER_DISABLED: HttpStatus.FORBIDDEN,
  DEVICE_NOT_TRUSTED: HttpStatus.FORBIDDEN,
  IDEMPOTENCY_KEY_REQUIRED: HttpStatus.BAD_REQUEST,
  IDEMPOTENCY_KEY_REUSED: HttpStatus.CONFLICT,
  IDEMPOTENCY_IN_PROGRESS: HttpStatus.CONFLICT,
  CONCURRENT_MODIFICATION: HttpStatus.CONFLICT,
  VERSION_CONFLICT: HttpStatus.CONFLICT,
  INSUFFICIENT_STOCK: HttpStatus.CONFLICT,
};

const HTTP_CODE: Readonly<Record<number, string>> = {
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "UNPROCESSABLE_ENTITY",
  429: "RATE_LIMITED",
};

export interface MappedError {
  readonly status: number;
  readonly envelope: ErrorEnvelope;
}

/**
 * Errors raised by the JSON body parser before routing (they carry a `type`
 * such as "entity.parse.failed" and a 4xx status). Their messages can quote
 * the raw body, so none of it is passed on.
 */
function bodyParserError(exception: unknown): ApplicationError | HttpException | undefined {
  if (typeof exception !== "object" || exception === null) return undefined;
  const { type, status } = exception as { type?: unknown; status?: unknown };
  if (typeof type !== "string" || typeof status !== "number" || status < 400 || status >= 500) return undefined;
  switch (type) {
    case "entity.parse.failed":
      return new ValidationError("Request body is not valid JSON", [{ path: ["body"], message: "malformed JSON" }]);
    case "entity.too.large":
      return new HttpException("Request body is too large", HttpStatus.PAYLOAD_TOO_LARGE);
    case "encoding.unsupported":
    case "charset.unsupported":
      return new HttpException("Unsupported request body encoding", HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    default:
      return new HttpException("Malformed request", HttpStatus.BAD_REQUEST);
  }
}

/** The only mapping from errors to HTTP responses; the filter and the body-parser handler both use it. */
export function mapError(raw: unknown): MappedError {
  const exception = bodyParserError(raw) ?? raw;
  if (exception instanceof ApplicationError) {
    const details = exception instanceof ValidationError && exception.issues.length > 0 ? exception.issues : undefined;
    return {
      status: APPLICATION_STATUS[exception.code],
      envelope: {
        error: { code: exception.code, message: exception.message, ...(details === undefined ? {} : { details }) },
      },
    };
  }
  if (exception instanceof HttpException && exception.getStatus() < 500) {
    const status = exception.getStatus();
    return { status, envelope: { error: { code: HTTP_CODE[status] ?? "BAD_REQUEST", message: exception.message } } };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    envelope: { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } },
  };
}

/** Logs and writes the envelope for an error (status and code only below 500; the full error server-side at 500). */
export function writeErrorResponse(logger: Logger, exception: unknown, response: Response): void {
  const { status, envelope } = mapError(exception);
  if (status >= 500) {
    logger.error("request failed", { status, code: envelope.error.code, error: exception });
  } else {
    logger.info("request rejected", { status, code: envelope.error.code });
  }
  if (response.headersSent) return;
  response.status(status).json(envelope);
}

/**
 * Express error middleware for failures raised before Nest routing (the JSON
 * body parser). It uses the same mapping as the filter.
 */
export function preRoutingErrorHandler(logger: Logger) {
  return (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
    if (response.headersSent) {
      next(error);
      return;
    }
    writeErrorResponse(logger, error, response);
  };
}

/**
 * The single place errors become HTTP responses (50-api.mdc). Every error is
 * returned as the shared ErrorEnvelope. Unexpected errors are logged in full
 * server-side and reach the client only as a generic INTERNAL_ERROR: no stack
 * traces, SQL or internal messages.
 */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  readonly #logger: Logger;

  constructor(@Inject(LOGGER) logger: Logger) {
    this.#logger = logger;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    writeErrorResponse(this.#logger, exception, host.switchToHttp().getResponse<Response>());
  }
}
