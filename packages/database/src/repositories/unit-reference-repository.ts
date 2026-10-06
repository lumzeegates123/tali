import type { UnitReferenceRepository } from "@tali/application";
import { defineUnit, type UnitKind } from "@tali/domain";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

/**
 * The global, read-only unit reference data (ADR-008 section 4.2). defineUnit
 * re-validates every stored row (code format, known kind, scale 0..3).
 */
export function createUnitReferenceRepository(): UnitReferenceRepository {
  return {
    async findByCode(scope, code) {
      const row = await transactionClient(scope).unitOfMeasure.findUnique({ where: { code } });
      return row === null ? undefined : defineUnit(row.code, row.kind as UnitKind, row.scale);
    },
  };
}
