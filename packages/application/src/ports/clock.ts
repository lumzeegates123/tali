/**
 * The server clock: the only time source for security and authorization
 * decisions (ADR-002 section 15). Returns a new Date for every call.
 */
export interface Clock {
  now(): Date;
}
