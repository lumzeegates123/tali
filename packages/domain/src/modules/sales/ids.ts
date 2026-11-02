import type { Id } from "../../kernel/index.js";
import { parseId } from "../../kernel/index.js";

export type SaleId = Id<"Sale">;

export function parseSaleId(value: string): SaleId {
  return parseId("Sale", value);
}
