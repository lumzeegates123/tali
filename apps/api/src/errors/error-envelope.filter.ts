import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Inject } from "@nestjs/common";
import { ApplicationError, type ApplicationErrorCode, ValidationError } from "@tali/application";
import type { ErrorEnvelope } from "@tali/shared";
import type { Response } from "express";
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
  IDEMPOTENCY_KEY_REQUIRED: HttpStatus.BAD_REQUEST,
  IDEMPOTENCY_KEY_REUSED: HttpStatus.CONFLICT,
  IDEMPOTENCY_IN_PROGRESS: HttpStatus.CONFLICT,
  CONCURRENT_MODIFICATION: HttpStatus.CONFLICT,
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

interface Mapped {
  readonly status: number;
  readonly envelope: ErrorEnvelope;
}

function map(exception: unknown): Mapped {
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
    const response = host.switchToHttp().getResponse<Response>();
    const { status, envelope } = map(exception);
    if (status >= 500) {
      this.#logger.error("request failed", { status, code: envelope.error.code, error: exception });
    } else {
      this.#logger.info("request rejected", { status, code: envelope.error.code });
    }
    if (response.headersSent) return;
    response.status(status).json(envelope);
  }
}
