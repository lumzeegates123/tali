import { parseCorrelationId } from "@tali/application";
import { describe, expect, it } from "vitest";
import { runWithCorrelationId } from "./correlation-context.js";
import { JsonLogger } from "./logger.js";

function capture(level: "info" | "warn" = "info") {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger({
    service: "svc",
    level,
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe("JsonLogger", () => {
  it("writes one structured JSON object per entry", () => {
    const { logger, lines } = capture();
    logger.info("hello", { count: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", service: "svc", msg: "hello", count: 2 });
    expect(typeof lines[0]?.["time"]).toBe("string");
  });

  it("respects the configured level", () => {
    const { logger, lines } = capture("warn");
    logger.info("dropped");
    logger.debug("dropped");
    logger.warn("kept");
    expect(lines.map((line) => line["msg"])).toEqual(["kept"]);
  });

  it("stamps the current correlation ID", () => {
    const { logger, lines } = capture();
    runWithCorrelationId(parseCorrelationId("corr-7"), () => {
      logger.info("inside");
    });
    logger.info("outside");
    expect(lines[0]?.["correlationId"]).toBe("corr-7");
    expect(lines[1]).not.toHaveProperty("correlationId");
  });

  it("redacts secret-like fields at any depth and serialises bigint and errors", () => {
    const { logger, lines } = capture();
    logger.info("redaction", {
      password: "hunter2",
      nested: { authorization: "Bearer abc", databaseUrl: "postgres://u:p@h/d", safe: "ok" },
      amountMinor: 9_007_199_254_740_993n,
      error: new Error("failed"),
    });
    const text = JSON.stringify(lines[0]);
    expect(text).not.toMatch(/hunter2|Bearer abc|postgres:\/\//);
    expect(lines[0]).toMatchObject({
      password: "[REDACTED]",
      nested: { authorization: "[REDACTED]", databaseUrl: "[REDACTED]", safe: "ok" },
      amountMinor: "9007199254740993",
      error: { name: "Error" },
    });
  });

  it("logs errors by name, code and stack frames only, never their message", () => {
    const { logger, lines } = capture();
    const prismaLike = Object.assign(
      new Error('Invalid `prisma.user.create()` invocation: { displayName: "synthetic-secret-name" }', {
        cause: new SyntaxError('"synthetic-raw-body" is not valid JSON'),
      }),
      { name: "PrismaClientValidationError", code: "P2009" },
    );
    logger.error("request failed", { error: prismaLike, other: Object.assign(new Error("x"), { code: "has spaces" }) });
    const text = JSON.stringify(lines[0]);
    expect(text).not.toMatch(/synthetic-secret-name|synthetic-raw-body|invocation/);
    expect(lines[0]).toMatchObject({
      error: { name: "PrismaClientValidationError", code: "P2009", cause: { name: "SyntaxError" } },
      other: { name: "Error" },
    });
    expect((lines[0]?.["other"] as Record<string, unknown>)["code"]).toBeUndefined();
    const stack = (lines[0]?.["error"] as { stack: string[] }).stack;
    expect(stack.length).toBeGreaterThan(0);
    expect(stack.every((frame) => frame.startsWith("at "))).toBe(true);
  });

  it("redacts identity material: JWTs, keys, claims, provider subjects, display names and contact details", () => {
    const { logger, lines } = capture();
    logger.info("identity", {
      jwt: "eyJhbGciOiJFUzI1NiJ9.e30.sig",
      accessToken: "a.b.c",
      bearer: "a.b.c",
      privateKey: "-----BEGIN PRIVATE KEY-----",
      signature: "sig",
      claims: { sub: "local-user-amina", roles: ["OWNER"] },
      providerSubject: "local-user-amina",
      subject: "local-user-amina",
      displayName: "Amina",
      email: "amina@example.test",
      phone: "+2340000000000",
      userId: "0190a000-0000-7000-8000-000000000001",
      reason: "verification_failed",
    });
    const text = JSON.stringify(lines[0]);
    expect(text).not.toMatch(/eyJ|a\.b\.c|PRIVATE KEY|local-user-amina|Amina|example\.test|\+234|OWNER/);
    expect(lines[0]).toMatchObject({
      userId: "0190a000-0000-7000-8000-000000000001",
      reason: "verification_failed",
      subject: "[REDACTED]",
      displayName: "[REDACTED]",
    });
  });
});
