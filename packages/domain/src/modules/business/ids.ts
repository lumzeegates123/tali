import type { Id } from "../../kernel/index.js";
import { parseId } from "../../kernel/index.js";

export type BusinessId = Id<"Business">;
/** Brand kept as "Membership" for the BusinessMembership entity (plan 003 section 0). */
export type MembershipId = Id<"Membership">;

export function parseBusinessId(value: string): BusinessId {
  return parseId("Business", value);
}

export function parseMembershipId(value: string): MembershipId {
  return parseId("Membership", value);
}
