import {
  ConcurrentModificationError,
  sealLockedValuations,
  type InventoryValuationRepository,
} from "@tali/application";
import type { BusinessId, InventoryValuationState, LocationId } from "@tali/domain";
import { Money, parseCurrencyCode, parseLocationId, parseProductVariantId, parseValuationStatus } from "@tali/domain";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

interface ValuationRow {
  readonly variant_id: string;
  readonly status: string;
  readonly value_minor: bigint;
  readonly currency: string;
  readonly first_valued_at: Date | null;
  readonly version: number;
  readonly started_from_balance_version: number;
}

function toState(businessId: BusinessId, locationId: LocationId, row: ValuationRow): InventoryValuationState {
  const currency = parseCurrencyCode(row.currency);
  return Object.freeze({
    businessId,
    locationId,
    variantId: parseProductVariantId(row.variant_id),
    status: parseValuationStatus(row.status),
    value: Money.ofMinor(row.value_minor, currency),
    firstValuedAt: row.first_valued_at ?? undefined,
    version: row.version,
    startedFromBalanceVersion: row.started_from_balance_version,
  });
}

export function createInventoryValuationRepository(): InventoryValuationRepository {
  return {
    async lockForUpdate(scope, lockedBalances, variantIds) {
      const ids = [...variantIds].sort();
      const businessId = lockedBalances.businessId;
      const locationId = lockedBalances.locationId;
      if (ids.length === 0) return sealLockedValuations({ businessId, locationId, valuations: [] });
      const client = transactionClient(scope);
      const startedFrom = ids.map((id) => {
        const balance = lockedBalances.balances.find((row) => row.variantId === id);
        if (balance === undefined) throw new Error("a valuation lock requires its locked balance");
        return balance.version;
      });
      await client.$executeRaw`
        INSERT INTO inventory_valuations
          (business_id, location_id, variant_id, status, value_minor, currency, first_valued_at, version,
           started_from_balance_version, updated_at)
        SELECT ${businessId}::uuid, ${locationId}::uuid, requested.variant_id, 'UNVALUED', 0, b.currency_code, NULL, 0,
               requested.started_from, statement_timestamp()
        FROM unnest(${ids}::uuid[], ${startedFrom}::int[]) AS requested(variant_id, started_from)
        JOIN businesses b ON b.id = ${businessId}::uuid
        ORDER BY requested.variant_id
        ON CONFLICT (business_id, location_id, variant_id) DO NOTHING`;
      const rows = await client.$queryRaw<ValuationRow[]>`
        SELECT variant_id::text AS variant_id, status, value_minor, currency, first_valued_at, version,
               started_from_balance_version
        FROM inventory_valuations
        WHERE business_id = ${businessId}::uuid AND location_id = ${locationId}::uuid
          AND variant_id = ANY(${ids}::uuid[])
        ORDER BY variant_id
        FOR UPDATE`;
      if (rows.length !== ids.length) throw new Error("every requested valuation must exist after it is created");
      return sealLockedValuations({
        businessId,
        locationId,
        valuations: rows.map((row) => toState(businessId, parseLocationId(locationId), row)),
      });
    },

    async apply(scope, locked, next) {
      const client = transactionClient(scope);
      for (const valuation of next) {
        const previous = locked.valuations.find((candidate) => candidate.variantId === valuation.variantId);
        if (
          previous === undefined ||
          valuation.businessId !== locked.businessId ||
          valuation.locationId !== locked.locationId ||
          valuation.startedFromBalanceVersion !== previous.startedFromBalanceVersion
        ) {
          throw new Error("only a locked valuation can be applied, with an immutable cutover watermark");
        }
        const count = await client.$executeRaw`
          UPDATE inventory_valuations
          SET status = ${valuation.status}, value_minor = ${valuation.value.amountMinor}::bigint,
              first_valued_at = ${valuation.firstValuedAt ?? null}::timestamptz,
              version = ${valuation.version}::int, updated_at = statement_timestamp()
          WHERE business_id = ${locked.businessId}::uuid AND location_id = ${locked.locationId}::uuid
            AND variant_id = ${valuation.variantId}::uuid AND version = ${previous.version}::int`;
        if (count !== 1) throw new ConcurrentModificationError();
      }
    },

    async find(scope, businessId, locationId, variantId) {
      const rows = await transactionClient(scope).$queryRaw<ValuationRow[]>`
        SELECT variant_id::text AS variant_id, status, value_minor, currency, first_valued_at, version,
               started_from_balance_version
        FROM inventory_valuations
        WHERE business_id = ${businessId}::uuid AND location_id = ${locationId}::uuid
          AND variant_id = ${variantId}::uuid`;
      const [row] = rows;
      return row === undefined ? undefined : toState(businessId, locationId, row);
    },
  };
}
