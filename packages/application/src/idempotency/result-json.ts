import type { JsonValue } from "../ports/queue-provider.js";

/** Readers for stored idempotency results. A malformed stored result is a programming or storage error. */
export type JsonObject = { readonly [key: string]: JsonValue };

export function objectAt(value: JsonValue | undefined, name: string): JsonObject {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`stored result "${name}" is not an object`);
  }
  return value as JsonObject;
}

export function textAt(object: JsonObject, name: string): string {
  const value = object[name];
  if (typeof value !== "string") throw new Error(`stored result "${name}" is not a string`);
  return value;
}

export function optionalTextAt(object: JsonObject, name: string): string | undefined {
  const value = object[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`stored result "${name}" is not a string`);
  return value;
}

export function instantAt(object: JsonObject, name: string): Date {
  return new Date(textAt(object, name));
}
