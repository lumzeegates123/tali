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
      error: { name: "Error", message: "failed" },
    });
  });
});
