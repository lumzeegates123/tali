import { type ArgumentsHost, BadRequestException, NotFoundException } from "@nestjs/common";
import {
  type ApplicationError,
  AuthenticationError,
  ConflictError,
  DependencyUnavailableError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  LocationRequiredError,
  NotFoundError,
  PermissionDeniedError,
  UserDisabledError,
  UserNotRegisteredError,
  ValidationError,
} from "@tali/application";
import { ErrorEnvelopeSchema } from "@tali/shared";
import { describe, expect, it } from "vitest";
import { JsonLogger } from "../observability/logger.js";
import { ErrorEnvelopeFilter } from "./error-envelope.filter.js";

function run(exception: unknown) {
  const logs: string[] = [];
  const filter = new ErrorEnvelopeFilter(
    new JsonLogger({ service: "t", level: "debug", sink: (line) => logs.push(line) }),
  );
  let status = 0;
  let body: unknown;
  const response = {
    headersSent: false,
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
  filter.catch(exception, host);
  return { status, body: ErrorEnvelopeSchema.parse(body), logs };
}

describe("ErrorEnvelopeFilter", () => {
  it.each([
    [new ValidationError("bad input"), 400, "VALIDATION_FAILED"],
    [new AuthenticationError(), 401, "UNAUTHENTICATED"],
    [new PermissionDeniedError(), 403, "PERMISSION_DENIED"],
    [new NotFoundError(), 404, "NOT_FOUND"],
    [new ConflictError("already exists"), 409, "CONFLICT"],
    [new LocationRequiredError(), 422, "LOCATION_REQUIRED"],
    [new DependencyUnavailableError("db down"), 503, "DEPENDENCY_UNAVAILABLE"],
    [new UserNotRegisteredError(), 403, "USER_NOT_REGISTERED"],
    [new UserDisabledError(), 403, "USER_DISABLED"],
    [new IdempotencyKeyRequiredError(), 400, "IDEMPOTENCY_KEY_REQUIRED"],
    [new IdempotencyKeyReusedError(), 409, "IDEMPOTENCY_KEY_REUSED"],
  ] as const)("maps %s to %i %s", (error: ApplicationError, status, code) => {
    const result = run(error);
    expect(result.status).toBe(status);
    expect(result.body.error.code).toBe(code);
  });

  it("includes validation issues as details", () => {
    const result = run(new ValidationError("bad", [{ path: ["name"], message: "required" }]));
    expect(result.body.error.details).toEqual([{ path: ["name"], message: "required" }]);
  });

  it("maps framework 4xx HttpExceptions to envelope codes", () => {
    expect(run(new NotFoundException()).body.error.code).toBe("NOT_FOUND");
    expect(run(new BadRequestException()).status).toBe(400);
  });

  it("hides unexpected errors behind a generic 500 and logs them", () => {
    const result = run(new TypeError("secret internal detail"));
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
    expect(result.logs.join("\n")).toMatch(/request failed/);
  });
});
