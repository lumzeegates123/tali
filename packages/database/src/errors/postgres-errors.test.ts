import { describe, expect, it } from "vitest";
import { isDatabaseUnavailable, isLockNotAvailable, isTransactionConflict, sqlStateOf } from "./postgres-errors.js";

/** Error shapes observed from Prisma 7.10 with @prisma/adapter-pg (see the module comment). */
const knownRequestError = (originalCode: string) =>
  Object.assign(new Error("raw query failed"), {
    name: "PrismaClientKnownRequestError",
    code: "P2010",
    meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode, kind: "postgres" } } },
  });

const writeConflict = (originalCode: string) =>
  Object.assign(new Error("TransactionWriteConflict"), {
    name: "DriverAdapterError",
    cause: { kind: "TransactionWriteConflict", originalCode },
  });

const pgDatabaseError = (code: string) => Object.assign(new Error("database error"), { code, severity: "ERROR" });

describe("sqlStateOf", () => {
  it("reads the SQLSTATE from each observed shape", () => {
    expect(sqlStateOf(knownRequestError("23505"))).toBe("23505");
    expect(sqlStateOf(writeConflict("40001"))).toBe("40001");
    expect(sqlStateOf(pgDatabaseError("55P03"))).toBe("55P03");
  });

  it("follows wrapping causes", () => {
    const wrapped = new Error("outer", { cause: new Error("middle", { cause: knownRequestError("40P01") }) });
    expect(sqlStateOf(wrapped)).toBe("40P01");
  });

  it("never mistakes a Prisma error code or a severity-less code for a SQLSTATE", () => {
    expect(sqlStateOf(Object.assign(new Error("p"), { code: "P2034" }))).toBe(undefined);
    expect(sqlStateOf(Object.assign(new Error("n"), { code: "40001" }))).toBe(undefined);
    expect(sqlStateOf(Object.assign(new Error("x"), { originalCode: "not a state" }))).toBe(undefined);
    expect(sqlStateOf("40001")).toBe(undefined);
    expect(sqlStateOf(undefined)).toBe(undefined);
  });

  it("terminates on a cyclic cause chain", () => {
    const a: { cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(sqlStateOf(a)).toBe(undefined);
  });
});

describe("classification", () => {
  it("serialization failures and deadlocks are transaction conflicts; nothing else is", () => {
    expect(isTransactionConflict(writeConflict("40001"))).toBe(true);
    expect(isTransactionConflict(writeConflict("40P01"))).toBe(true);
    expect(isTransactionConflict(knownRequestError("40001"))).toBe(true);
    expect(
      isTransactionConflict(Object.assign(new Error("p"), { name: "PrismaClientKnownRequestError", code: "P2034" })),
    ).toBe(true);
    expect(isTransactionConflict(knownRequestError("23505"))).toBe(false);
    expect(isTransactionConflict(knownRequestError("55P03"))).toBe(false);
    expect(isTransactionConflict(new Error("TransactionWriteConflict"))).toBe(false);
  });

  it("lock_not_available is recognised only for 55P03", () => {
    expect(isLockNotAvailable(knownRequestError("55P03"))).toBe(true);
    expect(isLockNotAvailable(writeConflict("40001"))).toBe(false);
  });
});

describe("isDatabaseUnavailable", () => {
  /** Observed from Prisma 7.10 with @prisma/adapter-pg against a closed port. */
  const unreachable = Object.assign(new Error("Can't reach database server at 127.0.0.1:59999"), {
    name: "PrismaClientKnownRequestError",
    code: "P1001",
    meta: { driverAdapterError: { name: "DriverAdapterError", cause: { kind: "DatabaseNotReachable" } } },
  });

  it("recognises unreachable, closed, exhausted and shutting-down databases", () => {
    expect(isDatabaseUnavailable(unreachable)).toBe(true);
    expect(isDatabaseUnavailable({ name: "DriverAdapterError", cause: { kind: "ConnectionClosed" } })).toBe(true);
    expect(isDatabaseUnavailable(Object.assign(new Error("pool"), { code: "P2024" }))).toBe(true);
    expect(
      isDatabaseUnavailable(new Error("outer", { cause: Object.assign(new Error("s"), { code: "ECONNREFUSED" }) })),
    ).toBe(true);
    expect(isDatabaseUnavailable(pgDatabaseError("08006"))).toBe(true);
    expect(isDatabaseUnavailable(pgDatabaseError("57P01"))).toBe(true);
    expect(isDatabaseUnavailable(pgDatabaseError("53300"))).toBe(true);
  });

  it("does not classify constraint violations, conflicts, lock timeouts or Prisma query errors", () => {
    expect(isDatabaseUnavailable(knownRequestError("23505"))).toBe(false);
    expect(isDatabaseUnavailable(writeConflict("40001"))).toBe(false);
    expect(isDatabaseUnavailable(pgDatabaseError("55P03"))).toBe(false);
    expect(isDatabaseUnavailable(Object.assign(new Error("p"), { code: "P2002" }))).toBe(false);
    expect(isDatabaseUnavailable(new Error("plain"))).toBe(false);
    expect(isDatabaseUnavailable(undefined)).toBe(false);
  });
});
