import type { UnitDefinition } from "../../kernel/index.js";
import { defineUnit } from "../../kernel/index.js";

/**
 * The initial seed of the global unit reference data (ADR-008 section 4.2).
 * The authoritative list is the `units_of_measure` table; this constant is
 * the reviewed seed it starts from. The list is not closed: adding a unit is
 * a reviewed migration with a kind and a scale. CARTON, CRATE, BAG, DOZEN and
 * BUNDLE are pack names, never stock units. No unit converts into another.
 */
export const INITIAL_UNITS_OF_MEASURE: readonly UnitDefinition[] = Object.freeze([
  defineUnit("PIECE", "COUNT", 0),
  defineUnit("BOTTLE", "COUNT", 0),
  defineUnit("SACHET", "COUNT", 0),
  defineUnit("TIN", "COUNT", 0),
  defineUnit("PACK", "COUNT", 0),
  defineUnit("KG", "MASS", 3),
  defineUnit("G", "MASS", 0),
  defineUnit("L", "VOLUME", 3),
  defineUnit("ML", "VOLUME", 0),
]);
