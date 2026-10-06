import { ConflictError } from "@tali/application";
import { describe, expect, it } from "vitest";
import { translatingUniqueViolations, uniqueViolationConstraint } from "./unique-violations.js";

/** Error shapes observed from Prisma 7.10 with @prisma/adapter-pg (see the module comment). */
const prismaUniqueViolation = (index: string) =>
  Object.assign(new Error("Unique constraint failed"), {
    name: "PrismaClientKnownRequestError",
    code: "P2002",
    meta: {
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: { kind: "UniqueConstraintViolation", originalCode: "23505", constraint: { index } },
      },
    },
  });

const pgUniqueViolation = (constraint: string) =>
  Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    severity: "ERROR",
    constraint,
  });

const CONFLICTS = { known_unique: "That value is already in use." };

describe("uniqueViolationConstraint", () => {
  it("reads the constraint from the driver-adapter and pg shapes", () => {
    expect(uniqueViolationConstraint(prismaUniqueViolation("known_unique"))).toBe("known_unique");
    expect(uniqueViolationConstraint(pgUniqueViolation("known_unique"))).toBe("known_unique");
    expect(uniqueViolationConstraint(new Error("outer", { cause: pgUniqueViolation("x_key") }))).toBe("x_key");
  });

  it("is undefined for any other SQLSTATE, even when a constraint is named", () => {
    const foreignKey = Object.assign(new Error("fk"), { code: "23503", severity: "ERROR", constraint: "known_unique" });
    const check = Object.assign(new Error("check"), { code: "23514", severity: "ERROR", constraint: "known_unique" });
    expect(uniqueViolationConstraint(foreignKey)).toBe(undefined);
    expect(uniqueViolationConstraint(check)).toBe(undefined);
    expect(uniqueViolationConstraint(new Error("plain"))).toBe(undefined);
    expect(uniqueViolationConstraint(undefined)).toBe(undefined);
  });
});

describe("translatingUniqueViolations", () => {
  it("returns the write's result", async () => {
    await expect(translatingUniqueViolations(CONFLICTS, async () => 7)).resolves.toBe(7);
  });

  it("reports a listed unique violation as ConflictError with only the listed message", async () => {
    for (const error of [prismaUniqueViolation("known_unique"), pgUniqueViolation("known_unique")]) {
      const failure: unknown = await translatingUniqueViolations(CONFLICTS, () => Promise.reject(error)).catch(
        (caught: unknown) => caught,
      );
      expect(failure).toBeInstanceOf(ConflictError);
      expect((failure as ConflictError).message).toBe("That value is already in use.");
      expect((failure as ConflictError).cause).toBe(undefined);
    }
  });

  it("propagates unlisted unique violations and every other failure unchanged", async () => {
    const unlisted = pgUniqueViolation("products_pkey");
    const foreignKey = Object.assign(new Error("fk"), { code: "23503", severity: "ERROR", constraint: "known_unique" });
    const plain = new Error("boom");
    for (const error of [unlisted, foreignKey, plain]) {
      await expect(translatingUniqueViolations(CONFLICTS, () => Promise.reject(error))).rejects.toBe(error);
    }
  });

  it("never matches inherited object keys", async () => {
    const error = pgUniqueViolation("toString");
    await expect(translatingUniqueViolations(CONFLICTS, () => Promise.reject(error))).rejects.toBe(error);
  });
});
