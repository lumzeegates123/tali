import type { SaleReceiptNumberIssuer } from "@tali/application";
import { formatOnlineReceiptNumber } from "@tali/domain";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

/**
 * Business-scoped online receipt numbers (ADR-011 section 8). The counter row
 * is created on the first sale of a business (a concurrent first insert waits
 * for the creating transaction, then does nothing), then locked FOR UPDATE and
 * moved forward by one. The use case calls this after every stock lock, so the
 * counter is always the last lock a sale takes. A rolled-back sale rolls its
 * counter update back with it.
 */
export function createSaleReceiptNumberIssuer(): SaleReceiptNumberIssuer {
  return {
    async issue(scope, businessId) {
      const client = transactionClient(scope);
      await client.$executeRaw`
        INSERT INTO sale_receipt_sequences (business_id, next_number, updated_at)
        VALUES (${businessId}::uuid, 1, statement_timestamp())
        ON CONFLICT (business_id) DO NOTHING`;
      const rows = await client.$queryRaw<{ next_number: bigint }[]>`
        SELECT next_number FROM sale_receipt_sequences WHERE business_id = ${businessId}::uuid FOR UPDATE`;
      const [row] = rows;
      if (row === undefined) throw new Error("the receipt counter must exist after it is created");
      const count = await client.$executeRaw`
        UPDATE sale_receipt_sequences SET next_number = next_number + 1, updated_at = statement_timestamp()
        WHERE business_id = ${businessId}::uuid AND next_number = ${row.next_number}::bigint`;
      if (count !== 1) throw new Error("the locked receipt counter changed");
      return formatOnlineReceiptNumber(row.next_number);
    },
  };
}
