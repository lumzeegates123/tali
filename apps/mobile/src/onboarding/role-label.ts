import type { BusinessSummary } from "../auth/session-store";

type Role = BusinessSummary["membership"]["role"];

const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  MANAGER: "Manager",
  CASHIER: "Cashier",
  STOCK_KEEPER: "Stock keeper",
  ACCOUNTANT: "Accountant",
};

/** Display text for a role returned by the API. It grants nothing: the server decides every permission. */
export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}
