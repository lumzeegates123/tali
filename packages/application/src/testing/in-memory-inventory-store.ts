import type {
  BusinessId,
  GoodsReceipt,
  InventoryAdjustment,
  InventoryMovement,
  InventoryMovementSource,
  LocationId,
  MembershipId,
  OpeningBatch,
  ProductVariant,
  ProductVariantId,
  StockBalance,
  StockThreshold,
} from "@tali/domain";
import { emptyStockBalance, Quantity } from "@tali/domain";
import { ConcurrentModificationError, ConflictError } from "../errors/application-error.js";
import type {
  GoodsReceiptRepository,
  InventoryAdjustmentRepository,
  InventoryMovementRepository,
  LockedBalances,
  OpeningBatchRepository,
  StockBalanceRepository,
  StockThresholdRepository,
} from "../modules/inventory/index.js";
import { assertDocumentReversal, assertThresholdTransition, sealLockedBalances } from "../modules/inventory/index.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import { FailureInjection } from "./failure-injection.js";
import type { InMemoryCatalogStore } from "./in-memory-catalog-store.js";
import type { InMemoryTenancyStore } from "./in-memory-tenancy-store.js";
import type { InMemoryUnitOfWork, RollbackParticipant } from "./in-memory-unit-of-work.js";

const stockItemKey = (businessId: BusinessId, locationId: LocationId, variantId: ProductVariantId) =>
  `${businessId}|${locationId}|${variantId}`;

const sourceKey = (source: InventoryMovementSource) => `${source.kind}|${source.id}`;

const byVariant = <T extends { readonly variantId: ProductVariantId }>(a: T, b: T) =>
  a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0;

type ReversibleDocument = GoodsReceipt | InventoryAdjustment;

/**
 * In-memory inventory documents, movements, balances and thresholds,
 * implementing the Build 2 Slice 5 inventory ports. It models the invariants
 * the W3 schema will enforce (business and location ownership, unique
 * movement IDs, one OPENING per stock item, one reversal per original, gap-free
 * balance versions, balances equal to the sum of their movements) so use case
 * tests fail on the same mistakes. It does not replace the database constraint
 * and concurrency tests: it has no isolation between concurrent runs.
 */
export class InMemoryInventoryStore implements RollbackParticipant {
  readonly failures = new FailureInjection();
  /** Runs before the existence check of `insertIfAbsent`, to simulate a concurrent creator committing first. */
  beforeInsertIfAbsent: ((threshold: StockThreshold) => void) | undefined;
  readonly #unitOfWork: InMemoryUnitOfWork | undefined;
  readonly #catalog: InMemoryCatalogStore;
  readonly #tenancy: InMemoryTenancyStore;
  readonly #lockTokens = new WeakMap<LockedBalances, TransactionScope>();
  #movements: InventoryMovement[] = [];
  #balances = new Map<string, StockBalance>();
  #openings = new Map<string, OpeningBatch>();
  #receipts = new Map<string, GoodsReceipt>();
  #adjustments = new Map<string, InventoryAdjustment>();
  #thresholds = new Map<string, StockThreshold>();
  readonly #committedElsewhere: StockThreshold[] = [];

  constructor(options: {
    readonly unitOfWork?: InMemoryUnitOfWork;
    readonly catalog: InMemoryCatalogStore;
    readonly tenancy: InMemoryTenancyStore;
  }) {
    this.#unitOfWork = options.unitOfWork;
    this.#catalog = options.catalog;
    this.#tenancy = options.tenancy;
    this.#unitOfWork?.enlist(this);
  }

  captureState(): () => void {
    const movements = [...this.#movements];
    const balances = new Map(this.#balances);
    const openings = new Map(this.#openings);
    const receipts = new Map(this.#receipts);
    const adjustments = new Map(this.#adjustments);
    const thresholds = new Map(this.#thresholds);
    const committedElsewhere = this.#committedElsewhere.length;
    return () => {
      this.#movements = movements;
      this.#balances = balances;
      this.#openings = openings;
      this.#receipts = receipts;
      this.#adjustments = adjustments;
      this.#thresholds = thresholds;
      for (const threshold of this.#committedElsewhere.slice(committedElsewhere)) this.#storeThreshold(threshold);
    };
  }

  #storeThreshold(threshold: StockThreshold): void {
    this.#thresholds.set(stockItemKey(threshold.businessId, threshold.locationId, threshold.variantId), threshold);
  }

  // Test setup.

  /**
   * Stores a threshold directly, as if committed by another transaction: it
   * survives a rollback of a unit of work that is running when it is put.
   */
  putThreshold(threshold: StockThreshold): this {
    this.#committedElsewhere.push(threshold);
    this.#storeThreshold(threshold);
    return this;
  }

  // Inspection.

  get movements(): readonly InventoryMovement[] {
    return [...this.#movements];
  }

  get balances(): readonly StockBalance[] {
    return [...this.#balances.values()];
  }

  get openings(): readonly OpeningBatch[] {
    return [...this.#openings.values()];
  }

  get receipts(): readonly GoodsReceipt[] {
    return [...this.#receipts.values()];
  }

  get adjustments(): readonly InventoryAdjustment[] {
    return [...this.#adjustments.values()];
  }

  get thresholds(): readonly StockThreshold[] {
    return [...this.#thresholds.values()];
  }

  balanceOf(businessId: BusinessId, locationId: LocationId, variantId: ProductVariantId): StockBalance | undefined {
    return this.#balances.get(stockItemKey(businessId, locationId, variantId));
  }

  /**
   * Throws unless every stored balance equals the sum of its stock item's
   * movements, its version their count and its last movement the latest one,
   * and every REVERSED document has exactly one reversal per original line.
   */
  assertConsistent(): void {
    for (const balance of this.#balances.values()) {
      const movements = this.#movements
        .filter((m) => stockItemKey(m.businessId, m.locationId, m.variantId) === this.#keyOf(balance))
        .sort((a, b) => a.balanceVersion - b.balanceVersion);
      let quantity = Quantity.zero(balance.quantity.unit);
      for (const [index, movement] of movements.entries()) {
        quantity = quantity.add(movement.delta);
        if (movement.balanceVersion !== index + 1 || !movement.balanceAfter.equals(quantity)) {
          throw new Error("movement versions or running balances are inconsistent");
        }
      }
      if (
        !balance.quantity.equals(quantity) ||
        balance.version !== movements.length ||
        balance.lastMovementId !== movements.at(-1)?.id
      ) {
        throw new Error("a balance does not equal its movements");
      }
    }
    const documents: readonly (readonly [InventoryMovementSource, ReversibleDocument])[] = [
      ...[...this.#receipts.values()].map((r) => [{ kind: "GOODS_RECEIPT", id: r.id }, r] as const),
      ...[...this.#adjustments.values()].map((a) => [{ kind: "ADJUSTMENT", id: a.id }, a] as const),
    ];
    for (const [source, document] of documents) {
      const mine = this.#movements.filter((m) => sourceKey(m.source) === sourceKey(source));
      const originals = mine.filter((m) => m.reversesMovementId === undefined);
      const reversals = mine.filter((m) => m.reversesMovementId !== undefined);
      const expected = document.status === "REVERSED" ? originals.length : 0;
      if (reversals.length !== expected) throw new Error("a document's reversal movements do not match its status");
    }
  }

  #keyOf(balance: StockBalance): string {
    return stockItemKey(balance.businessId, balance.locationId, balance.variantId);
  }

  #enter(scope: TransactionScope, operation: string): void {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check(operation);
  }

  #requireMemberOf(businessId: BusinessId, membershipId: MembershipId): void {
    const member = this.#tenancy.memberships.find((candidate) => candidate.id === membershipId);
    if (member?.businessId !== businessId) throw new Error("membership does not belong to the record's business");
  }

  #requireLocationOf(businessId: BusinessId, locationId: LocationId): void {
    const location = this.#tenancy.locations.find((candidate) => candidate.id === locationId);
    if (location?.businessId !== businessId) throw new Error("location does not belong to the record's business");
  }

  #variantOf(businessId: BusinessId, variantId: ProductVariantId): ProductVariant {
    const variant = this.#catalog.products.find((item) => item.variant.id === variantId)?.variant;
    if (variant?.businessId !== businessId) throw new Error("a stock item must reference a variant of its business");
    return variant;
  }

  #documentOf(source: InventoryMovementSource): { readonly businessId: BusinessId; readonly locationId: LocationId } {
    const document =
      source.kind === "OPENING_BATCH"
        ? this.#openings.get(source.id)
        : source.kind === "GOODS_RECEIPT"
          ? this.#receipts.get(source.id)
          : this.#adjustments.get(source.id);
    if (document === undefined) throw new Error("a movement must reference an existing document");
    return document;
  }

  #checkDocumentHeader(document: OpeningBatch | ReversibleDocument): void {
    if (this.#openings.has(document.id) || this.#receipts.has(document.id) || this.#adjustments.has(document.id)) {
      throw new Error("duplicate inventory document id");
    }
    this.#requireLocationOf(document.businessId, document.locationId);
    this.#requireMemberOf(document.businessId, document.actorMembershipId);
  }

  #checkMovement(movement: InventoryMovement, pending: readonly InventoryMovement[]): void {
    const all = [...this.#movements, ...pending];
    if (all.some((other) => other.id === movement.id)) throw new Error("duplicate movement id");
    this.#variantOf(movement.businessId, movement.variantId);
    this.#requireLocationOf(movement.businessId, movement.locationId);
    this.#requireMemberOf(movement.businessId, movement.actorMembershipId);
    const document = this.#documentOf(movement.source);
    if (document.businessId !== movement.businessId || document.locationId !== movement.locationId) {
      throw new Error("a movement must belong to its document's business and location");
    }
    const sameItem = all.filter(
      (other) =>
        other.businessId === movement.businessId &&
        other.locationId === movement.locationId &&
        other.variantId === movement.variantId,
    );
    if (sameItem.some((other) => other.balanceVersion === movement.balanceVersion)) {
      throw new ConflictError(
        "unique violation: inventory_movements (business_id, location_id, variant_id, balance_version)",
      );
    }
    if (movement.type === "OPENING" && sameItem.some((other) => other.type === "OPENING")) {
      throw new ConflictError("unique violation: inventory_movements one OPENING per stock item");
    }
    if (movement.reversesMovementId !== undefined) {
      const original = all.find((other) => other.id === movement.reversesMovementId);
      if (
        original?.businessId !== movement.businessId ||
        original.variantId !== movement.variantId ||
        original.reversesMovementId !== undefined ||
        sourceKey(original.source) !== sourceKey(movement.source) ||
        !original.delta.negate().equals(movement.delta)
      ) {
        throw new Error("a reversal must exactly negate an original movement of the same document");
      }
      if (all.some((other) => other.businessId === movement.businessId && other.reversesMovementId === original.id)) {
        throw new ConflictError("unique violation: inventory_movements (business_id, reverses_movement_id)");
      }
    }
  }

  readonly movementRepository: InventoryMovementRepository = {
    insertMany: async (scope, movements) => {
      this.#enter(scope, "movements.insertMany");
      const pending: InventoryMovement[] = [];
      for (const movement of movements) {
        this.#checkMovement(movement, pending);
        pending.push(movement);
      }
      this.#movements.push(...pending);
    },
    listOriginals: async (scope, businessId, source) => {
      this.#enter(scope, "movements.listOriginals");
      return this.#movements
        .filter(
          (m) =>
            m.businessId === businessId &&
            m.reversesMovementId === undefined &&
            sourceKey(m.source) === sourceKey(source),
        )
        .sort(byVariant);
    },
  };

  readonly balanceRepository: StockBalanceRepository = {
    lockForUpdate: async (scope, businessId, locationId, variantIds) => {
      this.#enter(scope, "balances.lockForUpdate");
      this.#requireLocationOf(businessId, locationId);
      const balances: StockBalance[] = [];
      for (const variantId of variantIds) {
        const key = stockItemKey(businessId, locationId, variantId);
        let balance = this.#balances.get(key);
        if (balance === undefined) {
          const { stockUnit } = this.#variantOf(businessId, variantId);
          balance = emptyStockBalance({ businessId, locationId, variantId, stockUnit });
          this.#balances.set(key, balance);
        }
        balances.push(balance);
      }
      const locked = sealLockedBalances({ businessId, locationId, balances });
      this.#lockTokens.set(locked, scope);
      return locked;
    },
    apply: async (scope, locked, next) => {
      this.#enter(scope, "balances.apply");
      if (this.#lockTokens.get(locked) !== scope) {
        throw new Error("balances must be locked in the same unit of work before they are applied");
      }
      for (const balance of next) {
        const lockedBalance = locked.balances.find((candidate) => candidate.variantId === balance.variantId);
        if (
          lockedBalance === undefined ||
          balance.businessId !== locked.businessId ||
          balance.locationId !== locked.locationId
        ) {
          throw new Error("only locked balances can be applied");
        }
        const key = this.#keyOf(balance);
        if (this.#balances.get(key)?.version !== lockedBalance.version) throw new ConcurrentModificationError();
        const latest = this.#movements
          .filter((m) => stockItemKey(m.businessId, m.locationId, m.variantId) === key)
          .reduce<InventoryMovement | undefined>(
            (last, m) => (last === undefined || m.balanceVersion > last.balanceVersion ? m : last),
            undefined,
          );
        if (
          latest === undefined ||
          balance.version !== latest.balanceVersion ||
          !balance.quantity.equals(latest.balanceAfter) ||
          balance.lastMovementId !== latest.id
        ) {
          throw new Error("a balance must equal the balance after its latest movement");
        }
        this.#balances.set(key, balance);
      }
    },
    find: async (scope, businessId, locationId, variantId) => {
      this.#enter(scope, "balances.find");
      return this.#balances.get(stockItemKey(businessId, locationId, variantId));
    },
  };

  readonly openingRepository: OpeningBatchRepository = {
    insert: async (scope, batch) => {
      this.#enter(scope, "openings.insert");
      this.#checkDocumentHeader(batch);
      this.#openings.set(batch.id, batch);
    },
    findById: async (scope, businessId, id) => {
      this.#enter(scope, "openings.findById");
      const batch = this.#openings.get(id);
      return batch?.businessId === businessId ? batch : undefined;
    },
  };

  readonly receiptRepository: GoodsReceiptRepository = {
    insert: async (scope, receipt) => {
      this.#enter(scope, "goodsReceipts.insert");
      this.#checkDocumentHeader(receipt);
      if (receipt.status !== "POSTED") throw new Error("a goods receipt is inserted POSTED");
      this.#receipts.set(receipt.id, receipt);
    },
    findById: async (scope, businessId, id) => {
      this.#enter(scope, "goodsReceipts.findById");
      const receipt = this.#receipts.get(id);
      return receipt?.businessId === businessId ? receipt : undefined;
    },
    findByIdForUpdate: async (scope, businessId, id) => {
      this.#enter(scope, "goodsReceipts.findByIdForUpdate");
      const receipt = this.#receipts.get(id);
      return receipt?.businessId === businessId ? receipt : undefined;
    },
    markReversed: async (scope, previous, next) => {
      this.#enter(scope, "goodsReceipts.markReversed");
      assertDocumentReversal(previous, next);
      const stored = this.#receipts.get(previous.id);
      if (stored?.businessId !== previous.businessId || stored.status !== "POSTED") {
        throw new ConcurrentModificationError();
      }
      if (next.reversedByMembershipId !== undefined)
        this.#requireMemberOf(next.businessId, next.reversedByMembershipId);
      this.#receipts.set(next.id, next);
    },
  };

  readonly adjustmentRepository: InventoryAdjustmentRepository = {
    insert: async (scope, adjustment) => {
      this.#enter(scope, "adjustments.insert");
      this.#checkDocumentHeader(adjustment);
      if (adjustment.status !== "POSTED") throw new Error("an adjustment is inserted POSTED");
      this.#adjustments.set(adjustment.id, adjustment);
    },
    findById: async (scope, businessId, id) => {
      this.#enter(scope, "adjustments.findById");
      const adjustment = this.#adjustments.get(id);
      return adjustment?.businessId === businessId ? adjustment : undefined;
    },
    findByIdForUpdate: async (scope, businessId, id) => {
      this.#enter(scope, "adjustments.findByIdForUpdate");
      const adjustment = this.#adjustments.get(id);
      return adjustment?.businessId === businessId ? adjustment : undefined;
    },
    markReversed: async (scope, previous, next) => {
      this.#enter(scope, "adjustments.markReversed");
      assertDocumentReversal(previous, next);
      const stored = this.#adjustments.get(previous.id);
      if (stored?.businessId !== previous.businessId || stored.status !== "POSTED") {
        throw new ConcurrentModificationError();
      }
      if (next.reversedByMembershipId !== undefined)
        this.#requireMemberOf(next.businessId, next.reversedByMembershipId);
      this.#adjustments.set(next.id, next);
    },
  };

  readonly thresholdRepository: StockThresholdRepository = {
    findForUpdate: async (scope, businessId, locationId, variantId) => {
      this.#enter(scope, "thresholds.findForUpdate");
      return this.#thresholds.get(stockItemKey(businessId, locationId, variantId));
    },
    insertIfAbsent: async (scope, threshold) => {
      this.#enter(scope, "thresholds.insertIfAbsent");
      const hook = this.beforeInsertIfAbsent;
      this.beforeInsertIfAbsent = undefined;
      hook?.(threshold);
      if (threshold.version !== 1) throw new Error("a new threshold row starts at version 1");
      this.#variantOf(threshold.businessId, threshold.variantId);
      this.#requireLocationOf(threshold.businessId, threshold.locationId);
      const key = stockItemKey(threshold.businessId, threshold.locationId, threshold.variantId);
      if (this.#thresholds.has(key)) return "exists";
      if ([...this.#thresholds.values()].some((other) => other.id === threshold.id)) {
        throw new Error("duplicate threshold id");
      }
      this.#thresholds.set(key, threshold);
      return "inserted";
    },
    update: async (scope, previous, next) => {
      this.#enter(scope, "thresholds.update");
      assertThresholdTransition(previous, next);
      const key = stockItemKey(previous.businessId, previous.locationId, previous.variantId);
      const stored = this.#thresholds.get(key);
      if (stored?.id !== previous.id || stored.version !== previous.version) throw new ConcurrentModificationError();
      this.#thresholds.set(key, next);
    },
    find: async (scope, businessId, locationId, variantId) => {
      this.#enter(scope, "thresholds.find");
      return this.#thresholds.get(stockItemKey(businessId, locationId, variantId));
    },
  };
}
