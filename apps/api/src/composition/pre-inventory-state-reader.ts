import type { VariantInventoryStateReader } from "@tali/application";
import type { VariantInventoryState } from "@tali/domain";

const NO_INVENTORY_YET: VariantInventoryState = Object.freeze({ hasMovements: false, hasNonZeroBalance: false });

/**
 * TEMPORARY. NOT AN INVENTORY IMPLEMENTATION AND NOT AUTHORITATIVE.
 *
 * Build 2 Slices 3 and 4 run before inventory exists: no inventory movement
 * or balance table, and no inventory use case, exists in the system, so
 * every variant truthfully has no movements and a zero balance. This reader
 * states that fact and nothing more; it performs no I/O. It is composed only
 * into UpdateProduct, whose stock-unit change guard (ADR-008 section 3.2)
 * needs it.
 *
 * SLICE 5 MUST DELETE OR REPLACE PreInventoryStateReader with the real
 * movement/balance-backed implementation. The moment any inventory table or
 * use case exists, this reader is false and invalid, and
 * pre-inventory-state-reader.test.ts fails the gate.
 */
export class PreInventoryStateReader implements VariantInventoryStateReader {
  async stateOf(): Promise<VariantInventoryState> {
    return NO_INVENTORY_YET;
  }
}
