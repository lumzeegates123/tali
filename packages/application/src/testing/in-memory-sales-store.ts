import type {
  BusinessId,
  LocationId,
  ProductVariantId,
  Sale,
  SaleId,
  SaleStockPosition,
  ValuationStatus,
} from "@tali/domain";
import { formatOnlineReceiptNumber } from "@tali/domain";
import { ConflictError } from "../errors/application-error.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import type { Page, PageRequest } from "../queries/pagination.js";
import type {
  SaleReceiptNumberIssuer,
  SaleRepository,
  SalesInventoryPort,
  SaleStockReversalWrite,
  SaleStockWrite,
} from "../modules/sales/ports.js";
import { FailureInjection } from "./failure-injection.js";
import type { InMemoryUnitOfWork, RollbackParticipant } from "./in-memory-unit-of-work.js";

interface StoredStock {
  readonly quantityMinor: bigint;
  readonly balanceVersion: number;
  readonly valuationStatus: ValuationStatus;
  readonly valueMinor: bigint;
  readonly valuationVersion: number;
}

const stockKey = (businessId: string, locationId: string, variantId: string) =>
  `${businessId}|${locationId}|${variantId}`;

/**
 * In-memory sales fakes. State rolls back with the in-memory unit of work.
 * The inventory port applies an already-decided plan and does not compute
 * weighted-average cost.
 */
export class InMemorySalesStore implements RollbackParticipant {
  readonly failures = new FailureInjection();
  readonly sales: SaleRepository;
  readonly receiptNumbers: SaleReceiptNumberIssuer;
  readonly inventory: SalesInventoryPort;
  #sales: readonly Sale[] = [];
  #sequences = new Map<string, bigint>();
  #stock = new Map<string, StoredStock>();
  #writes: readonly (SaleStockWrite | SaleStockReversalWrite)[] = [];

  constructor(unitOfWork: InMemoryUnitOfWork) {
    const gate = (scope: TransactionScope): void => {
      unitOfWork.assertActive(scope);
    };
    this.sales = {
      insert: async (scope, sale) => {
        gate(scope);
        this.failures.check("sales.insert");
        if (this.#sales.some((row) => row.businessId === sale.businessId && row.id === sale.id)) {
          throw new ConflictError("sale already exists");
        }
        this.#sales = [...this.#sales, sale];
        this.failures.checkAfter("sales.insert");
      },
      findById: async (scope, businessId, saleId) => {
        gate(scope);
        return this.#find(businessId, saleId);
      },
      findByIdForUpdate: async (scope, businessId, saleId) => {
        gate(scope);
        this.failures.check("sales.findByIdForUpdate");
        return this.#find(businessId, saleId);
      },
      markReversed: async (scope, sale) => {
        gate(scope);
        this.failures.check("sales.markReversed");
        if (this.#find(sale.businessId, sale.id)?.status !== "POSTED") {
          throw new ConflictError("sale is no longer posted");
        }
        this.#replace(sale);
        this.failures.checkAfter("sales.markReversed");
      },
      list: async (scope, businessId, query) => {
        gate(scope);
        return this.#list(businessId, query.locationId, query.recordedByMembershipId, query.page);
      },
    };
    this.receiptNumbers = {
      issue: async (scope, businessId) => {
        gate(scope);
        this.failures.check("sales.receipts.issue");
        const sequences = new Map(this.#sequences);
        const current = sequences.get(businessId) ?? 1n;
        sequences.set(businessId, current + 1n);
        this.#sequences = sequences;
        return formatOnlineReceiptNumber(current);
      },
    };
    this.inventory = {
      lockForSale: async (scope, businessId, locationId, variantIds) => {
        gate(scope);
        this.failures.check("sales.inventory.lockForSale");
        return [...variantIds].sort().map((variantId) => this.#position(businessId, locationId, variantId));
      },
      applySalePlan: async (scope, write) => {
        gate(scope);
        this.failures.check("sales.inventory.applySalePlan");
        this.#apply(
          write.businessId,
          write.locationId,
          write.effects.map((effect) => ({
            variantId: effect.variantId,
            balanceVersionRead: effect.balanceVersionRead,
            nextBalanceVersion: effect.nextBalanceVersion,
            quantityAfterMinor: effect.quantityAfterMinor,
            valuationVersionRead: effect.valuationVersionRead,
            nextValuationVersion: effect.nextValuationVersion,
            nextValueMinor: effect.nextValueMinor,
            nextValuationStatus: effect.nextValuationStatus,
          })),
        );
        this.#writes = [...this.#writes, write];
        this.failures.checkAfter("sales.inventory.applySalePlan");
      },
      applyReversalPlan: async (scope, write) => {
        gate(scope);
        this.failures.check("sales.inventory.applyReversalPlan");
        this.#apply(
          write.businessId,
          write.locationId,
          write.reversals.map((step) => step.plan),
        );
        this.#writes = [...this.#writes, write];
        this.failures.checkAfter("sales.inventory.applyReversalPlan");
      },
    };
  }

  putStock(props: {
    readonly businessId: BusinessId;
    readonly locationId: LocationId;
    readonly variantId: ProductVariantId;
    readonly quantityMinor: bigint;
    readonly valueMinor: bigint;
    readonly status: ValuationStatus;
    readonly balanceVersion?: number;
    readonly valuationVersion?: number;
  }): void {
    const stock = new Map(this.#stock);
    stock.set(stockKey(props.businessId, props.locationId, props.variantId), {
      quantityMinor: props.quantityMinor,
      valueMinor: props.valueMinor,
      valuationStatus: props.status,
      balanceVersion: props.balanceVersion ?? 1,
      valuationVersion: props.valuationVersion ?? (props.status === "VALUED" ? 1 : 0),
    });
    this.#stock = stock;
  }

  stockOf(businessId: string, locationId: string, variantId: string): StoredStock | undefined {
    return this.#stock.get(stockKey(businessId, locationId, variantId));
  }

  receiptSequence(businessId: string): bigint {
    return this.#sequences.get(businessId) ?? 1n;
  }

  /** Every committed stock write, in order, with the write context the use case passed. */
  stockWrites(): readonly (SaleStockWrite | SaleStockReversalWrite)[] {
    return this.#writes;
  }

  captureState(): () => void {
    const sales = this.#sales;
    const sequences = this.#sequences;
    const stock = this.#stock;
    const writes = this.#writes;
    return () => {
      this.#sales = sales;
      this.#sequences = sequences;
      this.#stock = stock;
      this.#writes = writes;
    };
  }

  #find(businessId: BusinessId, saleId: SaleId): Sale | undefined {
    return this.#sales.find((sale) => sale.businessId === businessId && sale.id === saleId);
  }

  #replace(sale: Sale): void {
    const index = this.#sales.findIndex((row) => row.businessId === sale.businessId && row.id === sale.id);
    if (index < 0) throw new ConflictError("sale was not stored");
    const next = [...this.#sales];
    next[index] = sale;
    this.#sales = next;
  }

  #list(
    businessId: BusinessId,
    locationId: LocationId,
    recordedByMembershipId: string | undefined,
    page: PageRequest,
  ): Page<Sale> {
    const rows = this.#sales
      .filter(
        (sale) =>
          sale.businessId === businessId &&
          sale.locationId === locationId &&
          (recordedByMembershipId === undefined || sale.recordedByMembershipId === recordedByMembershipId),
      )
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const start = page.after === undefined ? 0 : rows.findIndex((sale) => sale.id === page.after) + 1;
    const slice = rows.slice(Math.max(start, 0), Math.max(start, 0) + page.limit);
    const more = rows.length > Math.max(start, 0) + page.limit;
    const last = slice.at(-1);
    return { items: slice, nextCursor: more && last !== undefined ? last.id : null };
  }

  #position(businessId: BusinessId, locationId: LocationId, variantId: ProductVariantId): SaleStockPosition {
    const stored = this.#stock.get(stockKey(businessId, locationId, variantId));
    if (stored === undefined) {
      return Object.freeze({
        variantId,
        quantityMinor: 0n,
        balanceVersion: 0,
        valuationStatus: "UNVALUED",
        valueMinor: 0n,
        valuationVersion: 0,
      });
    }
    return Object.freeze({ variantId, ...stored });
  }

  #apply(
    businessId: BusinessId,
    locationId: LocationId,
    steps: readonly {
      readonly variantId: ProductVariantId;
      readonly balanceVersionRead: number;
      readonly nextBalanceVersion: number;
      readonly quantityAfterMinor: bigint;
      readonly valuationVersionRead: number;
      readonly nextValuationVersion: number;
      readonly nextValueMinor: bigint;
      readonly nextValuationStatus: ValuationStatus;
    }[],
  ): void {
    const stock = new Map(this.#stock);
    for (const step of steps) {
      const current = this.#position(businessId, locationId, step.variantId);
      const live = stock.get(stockKey(businessId, locationId, step.variantId));
      const version = live?.balanceVersion ?? current.balanceVersion;
      const valuationVersion = live?.valuationVersion ?? current.valuationVersion;
      if (version !== step.balanceVersionRead || valuationVersion !== step.valuationVersionRead) {
        throw new ConflictError("sale stock plan does not match the locked position");
      }
      stock.set(stockKey(businessId, locationId, step.variantId), {
        quantityMinor: step.quantityAfterMinor,
        balanceVersion: step.nextBalanceVersion,
        valuationStatus: step.nextValuationStatus,
        valueMinor: step.nextValueMinor,
        valuationVersion: step.nextValuationVersion,
      });
    }
    this.#stock = stock;
  }
}
