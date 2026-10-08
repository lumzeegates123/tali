import { createGoodsReceipt } from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { LocationBoundContext } from "../../context/business-context.js";
import { inventoryPermissions } from "../identity/index.js";
import { inventoryReceived } from "./audit-actions.js";
import type { GoodsReceiptSnapshot } from "./codecs.js";
import { goodsReceiptSnapshot, goodsReceiptSnapshotCodec } from "./codecs.js";
import type { StockLineInput } from "./inventory-common.js";
import { parseOptionalNote, parseOptionalReference, parseStockLines } from "./inventory-common.js";
import type { GoodsReceiptRepository } from "./ports.js";
import type { StockDocumentDependencies, StockDocumentKind, StockDocumentOutcome } from "./stock-document.js";
import { prepareInventoryCommand, runStockDocument } from "./stock-document.js";

export const POST_GOODS_RECEIPT_OPERATION = "inventory.goods_receipt.post.v1";

const GOODS_RECEIPT: StockDocumentKind<GoodsReceiptSnapshot> = {
  operation: POST_GOODS_RECEIPT_OPERATION,
  commandSchemaVersion: 1,
  resourceType: "goods_receipt",
  movementType: "PURCHASE_RECEIPT",
  archivedAllowed: false,
  codec: goodsReceiptSnapshotCodec,
};

export interface PostGoodsReceiptInput {
  readonly lines: readonly StockLineInput[];
  /** An optional delivery-note or invoice number, at most 64 characters. */
  readonly reference?: string;
  readonly note?: string;
  readonly idempotencyKey: string | undefined;
}

export type PostGoodsReceiptOutcome = StockDocumentOutcome<GoodsReceiptSnapshot>;

/**
 * `inventory:receive` (OWNER, MANAGER, STOCK_KEEPER). Keyed. Receives positive
 * quantities of ACTIVE, tracked products, directly or as whole packs, as one
 * quantity-only document: no supplier, purchase order or cost (ADR-008
 * sections 11 and 13).
 */
export interface PostGoodsReceipt {
  execute(context: LocationBoundContext, input: PostGoodsReceiptInput): Promise<PostGoodsReceiptOutcome>;
}

export function createPostGoodsReceipt(
  dependencies: StockDocumentDependencies & {
    readonly receipts: GoodsReceiptRepository;
    readonly audit: AuditRecorder;
  },
): PostGoodsReceipt {
  const permission = inventoryPermissions.permissions["inventory:receive"];
  return {
    async execute(context, input) {
      const prepared = prepareInventoryCommand(context, permission, input.idempotencyKey);
      const lines = parseStockLines(input.lines, { directions: false });
      const reference = parseOptionalReference(input.reference);
      const note = parseOptionalNote(input.note);
      return runStockDocument(dependencies, prepared, {
        kind: GOODS_RECEIPT,
        lines,
        fields: { reference, note },
        signed: (magnitude) => magnitude,
        createHeader: (plan) =>
          createGoodsReceipt({
            id: dependencies.ids.newId("GoodsReceipt"),
            businessId: plan.businessId,
            locationId: plan.locationId,
            ...(reference === undefined ? {} : { reference }),
            ...(note === undefined ? {} : { note }),
            recording: plan.recording,
          }),
        snapshot: goodsReceiptSnapshot,
        insertHeader: (scope, header) => dependencies.receipts.insert(scope, header),
        audit: (scope, header, key, lineCount) =>
          dependencies.audit.recordBusinessEvent(scope, inventoryReceived, {
            ...businessAuditEnvelope(prepared.context, key),
            locationId: prepared.context.locationId,
            entityId: header.id,
            payload: { lineCount, referencePresent: header.reference !== undefined },
          }),
      });
    },
  };
}
