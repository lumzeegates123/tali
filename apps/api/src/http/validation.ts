import { ValidationError, type ValidationIssue } from "@tali/application";

export type RequestPart = "body" | "query" | "path" | "headers";

/** The slice of a @tali/shared (Zod) wire schema this module uses. */
export interface WireSchema<T> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
        };
      };
}

const MAX_ISSUES = 20;
const MAX_MESSAGE_LENGTH = 200;
const MAX_PATH_SEGMENT_LENGTH = 64;

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * Parses one part of a request with its strict wire schema. Failures become
 * VALIDATION_FAILED with a bounded list of issues whose paths start with the
 * request part; nothing else from the parser reaches the client.
 */
export function parseRequest<T>(schema: WireSchema<T>, value: unknown, part: RequestPart): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues: ValidationIssue[] = result.error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: [
      part,
      ...issue.path.map((segment) =>
        typeof segment === "number" ? segment : bounded(String(segment), MAX_PATH_SEGMENT_LENGTH),
      ),
    ],
    message: bounded(issue.message, MAX_MESSAGE_LENGTH),
  }));
  throw new ValidationError("Request validation failed", issues);
}

/** Keyset page input with absent parameters omitted rather than set to undefined. */
export function toPageInput(query: { readonly limit?: number | undefined; readonly after?: string | undefined }): {
  readonly limit?: number;
  readonly after?: string;
} {
  return {
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.after === undefined ? {} : { after: query.after }),
  };
}
