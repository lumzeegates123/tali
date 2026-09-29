import type { Id } from "../../kernel/index.js";
import { parseId } from "../../kernel/index.js";

export type UserId = Id<"User">;
export type ExternalIdentityId = Id<"ExternalIdentity">;

export function parseUserId(value: string): UserId {
  return parseId("User", value);
}

export function parseExternalIdentityId(value: string): ExternalIdentityId {
  return parseId("ExternalIdentity", value);
}
