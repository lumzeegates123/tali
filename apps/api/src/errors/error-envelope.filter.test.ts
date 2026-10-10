import { type ArgumentsHost, BadRequestException, HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import {
  type ApplicationError,
  AuthenticationError,
  ConcurrentModificationError,
  ConflictError,
  DependencyUnavailableError,
  DeviceNotTrustedError,
  IdempotencyInProgressError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  InsufficientStockError,
  LocationRequiredError,
  NotFoundError,
  PermissionDeniedError,
  StocktakeStaleError,
  UserDisabledError,
  UserNotRegisteredError,
  ValidationError,
  VersionConflictError,
} from "@tali/application";
import { parseProductVariantId } from "@tali/domain";
import { ErrorEnvelopeSchema, StocktakeStaleErrorEnvelopeSchema } from "@tali/shared";
import { describe, expect, it } from "vitest";
import { JsonLogger } from "../observability/logger.js";
import { ErrorEnvelopeFilter, mapError, preRoutingErrorHandler } from "./error-envelope.filter.js";

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
    [new DeviceNotTrustedError(), 403, "DEVICE_NOT_TRUSTED"],
    [new IdempotencyKeyRequiredError(), 400, "IDEMPOTENCY_KEY_REQUIRED"],
    [new IdempotencyKeyReusedError(), 409, "IDEMPOTENCY_KEY_REUSED"],
    [new IdempotencyInProgressError(), 409, "IDEMPOTENCY_IN_PROGRESS"],
    [new ConcurrentModificationError(), 409, "CONCURRENT_MODIFICATION"],
    [new VersionConflictError(), 409, "VERSION_CONFLICT"],
    [new InsufficientStockError(), 409, "INSUFFICIENT_STOCK"],
    [
      new StocktakeStaleError([parseProductVariantId("019a0000-0000-7000-8000-000000000001")], 1),
      409,
      "STOCKTAKE_STALE",
    ],
  ] as const)("maps %s to %i %s", (error: ApplicationError, status, code) => {
    const result = run(error);
    expect(result.status).toBe(status);
    expect(result.body.error.code).toBe(code);
  });

  it("includes validation issues as details", () => {
    const result = run(new ValidationError("bad", [{ path: ["name"], message: "required" }]));
    expect(result.body.error.details).toEqual([{ path: ["name"], message: "required" }]);
  });

  describe("STOCKTAKE_STALE details", () => {
    const first = parseProductVariantId("019a0000-0000-7000-8000-000000000002");
    const second = parseProductVariantId("019a0000-0000-7000-8000-000000000001");

    it("carries exactly the sorted stale variant IDs and the stale line count, validated by the shared schema", () => {
      const result = run(new StocktakeStaleError([first, second], 7));
      expect(result.status).toBe(409);
      expect(StocktakeStaleErrorEnvelopeSchema.parse(result.body)).toEqual({
        error: {
          code: "STOCKTAKE_STALE",
          message: "The stocktake is stale and must be recounted",
          details: { staleVariantIds: [second, first], staleLineCount: 7 },
        },
      });
    });

    it("never passes other properties of an application error to the client", () => {
      const stale = Object.assign(new StocktakeStaleError([first], 1), {
        balanceVersions: [3],
        quantities: ["10"],
        businessId: "019a0000-0000-7000-8000-00000000000b",
      });
      const conflict = Object.assign(new ConflictError("already exists"), { staleVariantIds: [first], secret: "x" });
      expect(run(stale).body.error.details).toEqual({ staleVariantIds: [first], staleLineCount: 1 });
      expect(run(conflict).body.error).toEqual({ code: "CONFLICT", message: "already exists" });
    });

    it("answers stale details that break the shared schema as a generic 500", () => {
      const corrupt = new StocktakeStaleError([first], 1);
      Object.defineProperty(corrupt, "staleVariantIds", { value: ["not-a-uuid"] });
      const result = run(corrupt);
      expect(result.status).toBe(500);
      expect(result.body).toEqual({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
    });
  });

  it("keeps validation details unchanged and omits empty ones", () => {
    expect(run(new ValidationError("bad")).body.error).toEqual({ code: "VALIDATION_FAILED", message: "bad" });
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

  it("never passes database, Prisma or token-library detail to the client", () => {
    const prismaLike = Object.assign(new Error('Invalid `prisma.user.create()` invocation: relation "users"'), {
      code: "P2002",
      meta: { target: ["provider_subject"] },
    });
    const joseLike = Object.assign(new Error('"exp" claim timestamp check failed'), { code: "ERR_JWT_EXPIRED" });
    for (const error of [prismaLike, joseLike]) {
      const result = run(error);
      expect(result.status).toBe(500);
      expect(JSON.stringify(result.body)).not.toMatch(/prisma|users|provider_subject|claim|timestamp|P2002|ERR_JWT/);
    }
  });

  it("maps the rate limit to 429 RATE_LIMITED", () => {
    const result = run(new HttpException("Too many sign-in attempts", HttpStatus.TOO_MANY_REQUESTS));
    expect(result).toMatchObject({ status: 429, body: { error: { code: "RATE_LIMITED" } } });
  });
});

describe("body-parser errors", () => {
  const parserError = (type: string, status: number, message = 'Unexpected token } in JSON at "secret-body"') =>
    Object.assign(new Error(message), { type, status, body: "secret-body" });

  it.each([
    ["entity.parse.failed", 400, 400, "VALIDATION_FAILED"],
    ["entity.too.large", 413, 413, "PAYLOAD_TOO_LARGE"],
    ["encoding.unsupported", 415, 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["charset.unsupported", 415, 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["request.aborted", 400, 400, "BAD_REQUEST"],
  ] as const)("maps %s to %i", (type, parserStatus, status, code) => {
    const mapped = mapError(parserError(type, parserStatus));
    expect(mapped.status).toBe(status);
    expect(mapped.envelope.error.code).toBe(code);
    expect(JSON.stringify(mapped.envelope)).not.toContain("secret-body");
  });

  it("describes malformed JSON as a body validation issue", () => {
    expect(mapError(parserError("entity.parse.failed", 400)).envelope.error.details).toEqual([
      { path: ["body"], message: "malformed JSON" },
    ]);
  });

  it("does not treat 5xx or untyped errors as body-parser errors", () => {
    expect(mapError(parserError("stream.encoding.set", 500)).status).toBe(500);
    expect(mapError(Object.assign(new Error("x"), { status: 400 })).status).toBe(500);
  });

  it("is written by the pre-routing middleware with the same mapping, or deferred once headers are sent", () => {
    const logs: string[] = [];
    const handler = preRoutingErrorHandler(
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
    let forwarded: unknown;
    const error = parserError("entity.too.large", 413);
    handler(error, {} as never, response as never, (value?: unknown) => (forwarded = value));
    expect(status).toBe(413);
    expect(ErrorEnvelopeSchema.parse(body).error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(forwarded).toBeUndefined();

    response.headersSent = true;
    handler(error, {} as never, response as never, (value?: unknown) => (forwarded = value));
    expect(forwarded).toBe(error);
  });
});
