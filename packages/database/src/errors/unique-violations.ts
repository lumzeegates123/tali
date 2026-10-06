import { ConflictError } from "@tali/application";
import { sqlStateOf } from "./postgres-errors.js";

export const UNIQUE_VIOLATION = "23505";
const MAX_VISITS = 16;

function property(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined;
}

/**
 * The name of the unique constraint or index behind a unique violation
 * (SQLSTATE 23505), or undefined for any other error. Observed shapes
 * (Prisma 7.10, @prisma/adapter-pg 7.10): the driver-adapter error cause
 * carries `constraint: { index: name }`; a pg DatabaseError (reached directly
 * in tests) carries `constraint: name`.
 */
export function uniqueViolationConstraint(error: unknown): string | undefined {
  if (sqlStateOf(error) !== UNIQUE_VIOLATION) return undefined;
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0 && visited.size < MAX_VISITS) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || visited.has(current)) continue;
    visited.add(current);
    const constraint = property(current, "constraint");
    if (typeof constraint === "string" && constraint.length > 0) return constraint;
    const index = property(constraint, "index");
    if (typeof index === "string" && index.length > 0) return index;
    pending.push(property(current, "cause"), property(property(current, "meta"), "driverAdapterError"));
  }
  return undefined;
}

/**
 * Runs a write and reports a violation of one of the listed unique
 * constraints as ConflictError with the listed, caller-safe message: a lost
 * race against a concurrent request (ADR-008 section 5). The message never
 * names the constraint or carries database text. Any other failure,
 * including a violation of an unlisted constraint, propagates unchanged.
 */
export async function translatingUniqueViolations<T>(
  conflicts: Readonly<Record<string, string>>,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint !== undefined && Object.hasOwn(conflicts, constraint)) {
      throw new ConflictError(conflicts[constraint] as string);
    }
    throw error;
  }
}
