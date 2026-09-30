/**
 * Recovers PostgreSQL SQLSTATE codes from errors raised through Prisma 7 and
 * the pg driver adapter. Observed shapes (Prisma 7.10, @prisma/adapter-pg 7.10):
 *
 * - raw and model queries: PrismaClientKnownRequestError whose
 *   `meta.driverAdapterError.cause.originalCode` is the SQLSTATE;
 * - serialization failures and deadlocks (40001, 40P01) at statement or
 *   commit time: a bare DriverAdapterError "TransactionWriteConflict" whose
 *   `cause.originalCode` is the SQLSTATE;
 * - a pg DatabaseError (reached directly in tests), whose `code` is the
 *   SQLSTATE and which carries `severity`.
 *
 * Prisma's own codes (P2010, P2034) are never mistaken for a SQLSTATE: a bare
 * `code` counts only on an object that also carries a PostgreSQL `severity`.
 */
const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_VISITS = 16;

export const LOCK_NOT_AVAILABLE = "55P03";
export const SERIALIZATION_FAILURE = "40001";
export const DEADLOCK_DETECTED = "40P01";

function property(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined;
}

/** The SQLSTATE behind an error, or undefined when none is recoverable. */
export function sqlStateOf(error: unknown): string | undefined {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0 && visited.size < MAX_VISITS) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || visited.has(current)) continue;
    visited.add(current);
    const original = property(current, "originalCode");
    if (typeof original === "string" && SQLSTATE.test(original)) return original;
    const code = property(current, "code");
    if (typeof code === "string" && SQLSTATE.test(code) && typeof property(current, "severity") === "string") {
      return code;
    }
    pending.push(property(current, "cause"), property(property(current, "meta"), "driverAdapterError"));
  }
  return undefined;
}

/**
 * A serialization failure or deadlock (ADR-004 section 11): the only failures
 * the unit of work retries. Also recognises Prisma's P2034 ("write conflict or
 * deadlock"), which carries no SQLSTATE.
 */
export function isTransactionConflict(error: unknown): boolean {
  const state = sqlStateOf(error);
  if (state === SERIALIZATION_FAILURE || state === DEADLOCK_DETECTED) return true;
  return property(error, "name") === "PrismaClientKnownRequestError" && property(error, "code") === "P2034";
}

/** A lock wait exceeded lock_timeout (or a NOWAIT lock was unavailable). Never retried. */
export function isLockNotAvailable(error: unknown): boolean {
  return sqlStateOf(error) === LOCK_NOT_AVAILABLE;
}

/** Prisma codes for an unreachable server, a dropped connection or pool exhaustion. */
const UNAVAILABLE_PRISMA_CODES = new Set(["P1001", "P1002", "P1017", "P2024"]);
/** @prisma/driver-adapter-utils error kinds for the same conditions. */
const UNAVAILABLE_ADAPTER_KINDS = new Set([
  "DatabaseNotReachable",
  "ConnectionClosed",
  "SocketTimeout",
  "TooManyConnections",
  "TlsConnectionError",
]);
/** Node.js socket errors seen when the driver cannot reach the server. */
const UNAVAILABLE_SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

/**
 * The database cannot be reached or is refusing work (ADR-005 section 13.1:
 * DEPENDENCY_UNAVAILABLE): SQLSTATE class 08 (connection exception), 57P01 to
 * 57P03 (shutdown, cannot connect now), 53300 (too many connections), the
 * matching Prisma and driver-adapter errors, or a socket failure.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  const state = sqlStateOf(error);
  if (state !== undefined) {
    return state.startsWith("08") || ["57P01", "57P02", "57P03", "53300"].includes(state);
  }
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0 && visited.size < MAX_VISITS) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || visited.has(current)) continue;
    visited.add(current);
    const code = property(current, "code");
    const kind = property(current, "kind");
    if (typeof code === "string" && (UNAVAILABLE_PRISMA_CODES.has(code) || UNAVAILABLE_SOCKET_CODES.has(code))) {
      return true;
    }
    if (typeof kind === "string" && UNAVAILABLE_ADAPTER_KINDS.has(kind)) return true;
    pending.push(property(current, "cause"), property(property(current, "meta"), "driverAdapterError"));
  }
  return false;
}

/**
 * Internal: a transaction attempt failed with a serialization failure or
 * deadlock (ADR-004 section 11 "TransactionConflict"). The unit of work
 * retries it and never lets it escape; after the last attempt it becomes
 * ConcurrentModificationError.
 */
export class TransactionConflict extends Error {
  constructor(options: { cause: unknown }) {
    super("transaction conflict (serialization failure or deadlock)", options);
    this.name = "TransactionConflict";
  }
}
