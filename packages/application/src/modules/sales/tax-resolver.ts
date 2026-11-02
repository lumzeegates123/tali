import { noTaxSnapshot, type Money, type SaleTaxSnapshot } from "@tali/domain";

/**
 * The only tax input RecordSale accepts. S4 returns NONE for every line and
 * never reads a client tax value. S8 can replace this resolver without
 * changing the Sale aggregate (ADR-010 section 11; ADR-011 section 12).
 */
export interface SaleTaxSnapshotResolver {
  resolve(net: Money): SaleTaxSnapshot;
}

export function createNoTaxSnapshotResolver(): SaleTaxSnapshotResolver {
  return {
    resolve(net) {
      return noTaxSnapshot(net);
    },
  };
}
