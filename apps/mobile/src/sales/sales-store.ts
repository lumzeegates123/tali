import { type CurrencyDefinition, Money } from "@tali/domain/kernel";
import type { MoneyWire, ProductResponse, SaleResponse, UnitResponse } from "@tali/shared";
import { currencyDefinition } from "../catalog/money-format";
import { definitionFor, formatQuantity } from "../inventory/inventory-format";
import { KeyedCommand } from "../inventory/keyed-command";
import type { ApiFailure, ApiResult, TaliApiClient } from "../api/tali-api-client";
import type { BusinessRequestCredentials, BusinessRequestPolicy, BusinessRequestResult } from "../auth/session-store";
import {
  buildSalePayload,
  type CartLine,
  type LineErrors,
  MAX_CART_LINES,
  MAX_TENDERS,
  type SalePayload,
  type TenderDraft,
  type TenderErrors,
  type TenderMethod,
} from "./sale-draft";

/** The part of the session sales uses: one request at a time for the selected business. */
export interface SalesSession {
  businessRequest<T>(
    businessId: string,
    policy: BusinessRequestPolicy,
    send: (api: TaliApiClient, credentials: BusinessRequestCredentials) => Promise<ApiResult<T>>,
  ): Promise<BusinessRequestResult<T>>;
}

export type LoadPhase = "loading" | "ready" | "failed";

/**
 * `editing`: the cart may change. `submitting`: a sale request is in flight.
 * `unconfirmed`: Tali could not confirm whether the sale was recorded; the cart
 * is locked until the same sale is submitted again or the attempt is discarded.
 */
export type CheckoutPhase = "editing" | "submitting" | "unconfirmed";

export interface SalesPagedList {
  /** In the API's order (ascending by sale ID), without duplicates. */
  readonly items: readonly SaleResponse[];
  readonly nextCursor: string | null;
  readonly phase: LoadPhase;
  readonly failure: ApiFailure | undefined;
  readonly loadingMore: boolean;
  readonly moreFailure: ApiFailure | undefined;
}

export interface CheckoutState {
  readonly phase: CheckoutPhase;
  /** The last definite rejection of the sale; the cart is kept. */
  readonly failure: ApiFailure | undefined;
  /** From TENDER_TOTAL_MISMATCH: the total Tali calculated, in the business currency. */
  readonly serverTotal: MoneyWire | undefined;
  readonly formError: string | undefined;
  readonly lineErrors: Readonly<Record<string, LineErrors>>;
  readonly tenderErrors: Readonly<Record<string, TenderErrors>>;
  /** Guidance from the API's answer, per cart variant (price changed, price not set, stock available, ...). */
  readonly lineNotices: Readonly<Record<string, string>>;
}

/** Everything sales components may render. It never holds a token, device credential, sale ID claim or key. */
export interface SalesSnapshot {
  readonly businessUnavailable: boolean;
  readonly reference: {
    readonly phase: LoadPhase;
    readonly currency: CurrencyDefinition | undefined;
    readonly units: readonly UnitResponse[];
    readonly failure: ApiFailure | undefined;
  };
  readonly search: {
    readonly query: string;
    readonly phase: "idle" | LoadPhase;
    readonly items: readonly ProductResponse[];
    readonly failure: ApiFailure | undefined;
  };
  readonly lines: readonly CartLine[];
  readonly tenders: readonly TenderDraft[];
  readonly checkout: CheckoutState;
  /** The sale just recorded, exactly as the API returned it. */
  readonly receipt: SaleResponse | undefined;
  readonly history: SalesPagedList;
  readonly reversal: { readonly inFlight: boolean; readonly unconfirmed: boolean };
}

export type SalesOutcome<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "failed"; readonly failure: ApiFailure }
  /** Tali could not confirm the outcome, or a changed command was refused while one is unconfirmed. */
  | { readonly status: "unconfirmed" }
  /** Superseded, disposed, invalid input, already in flight, or handled by the session or business state. */
  | { readonly status: "ignored" };

export type AddProductResult = "added" | "alreadyInCart" | "priceNotSet" | "cartFull" | "locked";

export interface SalesStoreOptions {
  readonly businessId: string;
  readonly session: SalesSession;
  /** A fresh UUIDv7 for each new sale ID and each reversal key. */
  readonly newIdempotencyKey: () => string;
}

export const SEARCH_PAGE_SIZE = 20;

const IGNORED: { readonly status: "ignored" } = Object.freeze({ status: "ignored" });

const NO_ERRORS: Pick<CheckoutState, "formError" | "lineErrors" | "tenderErrors"> = {
  formError: undefined,
  lineErrors: {},
  tenderErrors: {},
};

const EDITING: CheckoutState = {
  phase: "editing",
  failure: undefined,
  serverTotal: undefined,
  ...NO_ERRORS,
  lineNotices: {},
};

function emptyHistory(): SalesPagedList {
  return {
    items: [],
    nextCursor: null,
    phase: "loading",
    failure: undefined,
    loadingMore: false,
    moreFailure: undefined,
  };
}

function appendUnique(existing: readonly SaleResponse[], page: readonly SaleResponse[]): SaleResponse[] {
  const seen = new Set(existing.map((sale) => sale.saleId));
  const appended = [...existing];
  for (const sale of page) {
    if (seen.has(sale.saleId)) continue;
    seen.add(sale.saleId);
    appended.push(sale);
  }
  return appended;
}

/**
 * Sales for one selected business (plan 005 Slice 7), in memory only: the
 * cart, tender rows, the sale being submitted and its idempotency key live
 * here and nowhere else, and are dropped when the Sales section unmounts
 * (business switch, sign-out). Nothing is stored on the device; the token and
 * device headers are supplied per request by the session and never kept. The API is authoritative for prices, discounts,
 * tax, totals, change, cost, stock and permissions: this store sends what the
 * person entered and shows what the API returns.
 */
export class SalesStore {
  readonly #businessId: string;
  readonly #session: SalesSession;
  readonly #listeners = new Set<() => void>();
  readonly #sale: KeyedCommand<SalePayload>;
  readonly #reversal: KeyedCommand<{ readonly saleId: string; readonly reason: string }>;
  /** The exact payload of an unconfirmed sale, resent unchanged with the same key. */
  #pending: SalePayload | undefined;
  #snapshot: SalesSnapshot;
  #disposed = false;
  #referenceGeneration = 0;
  #searchGeneration = 0;
  #historyGeneration = 0;
  #tenderRows = 0;

  constructor(options: SalesStoreOptions) {
    this.#businessId = options.businessId;
    this.#session = options.session;
    this.#sale = new KeyedCommand(options.newIdempotencyKey);
    this.#reversal = new KeyedCommand(options.newIdempotencyKey);
    this.#snapshot = Object.freeze<SalesSnapshot>({
      businessUnavailable: false,
      reference: { phase: "loading", currency: undefined, units: [], failure: undefined },
      search: { query: "", phase: "idle", items: [], failure: undefined },
      lines: [],
      tenders: [this.#newTender("CASH")],
      checkout: EDITING,
      receipt: undefined,
      history: emptyHistory(),
      reversal: { inFlight: false, unconfirmed: false },
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SalesSnapshot => this.#snapshot;

  get businessId(): string {
    return this.#businessId;
  }

  /** Loads the business currency and units. */
  start(): void {
    void this.loadReference();
  }

  /** Ignores every later result and forgets the cart, tenders, pending sale and every key. */
  dispose(): void {
    this.#disposed = true;
    this.#sale.reset();
    this.#reversal.reset();
    this.#pending = undefined;
    this.#listeners.clear();
  }

  // ---- Reference data (business scope) -----------------------------------

  async loadReference(): Promise<void> {
    const generation = ++this.#referenceGeneration;
    this.#patch({ reference: { ...this.#snapshot.reference, phase: "loading", failure: undefined } });
    const [currency, units] = await Promise.all([
      this.#request("business", (api, { token, device }) => api.getBusinessCurrency(token, this.#businessId, device)),
      this.#request("business", (api, { token, device }) => api.listUnits(token, this.#businessId, device)),
    ]);
    if (generation !== this.#referenceGeneration) return;
    const failure =
      currency.status === "failed" ? currency.failure : units.status === "failed" ? units.failure : undefined;
    if (failure !== undefined || currency.status !== "ok" || units.status !== "ok") {
      if (failure !== undefined) {
        this.#patch({ reference: { phase: "failed", currency: undefined, units: [], failure } });
      }
      return;
    }
    const definition = currencyDefinition(currency.value);
    this.#patch({
      reference:
        definition === undefined
          ? {
              phase: "failed",
              currency: undefined,
              units: [],
              failure: { kind: "invalid-response", status: 200, correlationId: undefined },
            }
          : { phase: "ready", currency: definition, units: units.value.items, failure: undefined },
    });
  }

  // ---- Product search (business scope) -----------------------------------

  /** `GET .../products?status=ACTIVE&q=`: the first page of matching active products. */
  async searchProducts(query: string): Promise<void> {
    const q = query.trim();
    const generation = ++this.#searchGeneration;
    this.#patch({ search: { query: q, phase: "loading", items: [], failure: undefined } });
    const outcome = await this.#request("business", (api, { token, device }) =>
      api.listProducts(
        token,
        this.#businessId,
        { status: "ACTIVE", limit: SEARCH_PAGE_SIZE, ...(q === "" ? {} : { q }) },
        device,
      ),
    );
    if (generation !== this.#searchGeneration || (outcome.status !== "ok" && outcome.status !== "failed")) return;
    this.#patch({
      search:
        outcome.status === "failed"
          ? { query: q, phase: "failed", items: [], failure: outcome.failure }
          : { query: q, phase: "ready", items: outcome.value.items, failure: undefined },
    });
  }

  // ---- Cart (memory only) ------------------------------------------------

  get #locked(): boolean {
    return this.#snapshot.checkout.phase !== "editing";
  }

  /** Adds one row per variant at the displayed price; a product without a price cannot be sold. */
  addProduct(product: ProductResponse): AddProductResult {
    if (this.#locked) return "locked";
    if (this.#snapshot.lines.some((line) => line.variantId === product.variantId)) return "alreadyInCart";
    if (product.sellingPrice === null || product.priceVersion < 1) return "priceNotSet";
    if (this.#snapshot.lines.length >= MAX_CART_LINES) return "cartFull";
    const line: CartLine = {
      variantId: product.variantId,
      productId: product.id,
      name: product.name,
      sku: product.sku,
      stockUnit: product.stockUnit,
      displayedPrice: product.sellingPrice,
      priceVersion: product.priceVersion,
      quantityText: "1",
      discountKind: "NONE",
      discountText: "",
    };
    this.#patch({ lines: [...this.#snapshot.lines, line], receipt: undefined, checkout: this.#edited() });
    return "added";
  }

  updateLine(variantId: string, change: Partial<Pick<CartLine, "quantityText" | "discountKind" | "discountText">>) {
    if (this.#locked) return;
    this.#patch({
      lines: this.#snapshot.lines.map((line) => (line.variantId === variantId ? { ...line, ...change } : line)),
      checkout: this.#edited(),
    });
  }

  removeLine(variantId: string): void {
    if (this.#locked) return;
    const lineNotices = Object.fromEntries(
      Object.entries(this.#snapshot.checkout.lineNotices).filter(([id]) => id !== variantId),
    );
    this.#patch({
      lines: this.#snapshot.lines.filter((line) => line.variantId !== variantId),
      checkout: { ...this.#edited(), lineNotices },
    });
  }

  addTender(method: TenderMethod): void {
    if (this.#locked || this.#snapshot.tenders.length >= MAX_TENDERS) return;
    this.#patch({ tenders: [...this.#snapshot.tenders, this.#newTender(method)], checkout: this.#edited() });
  }

  updateTender(rowId: string, change: Partial<Omit<TenderDraft, "rowId">>): void {
    if (this.#locked) return;
    this.#patch({
      tenders: this.#snapshot.tenders.map((tender) => {
        if (tender.rowId !== rowId) return tender;
        const next = { ...tender, ...change };
        // A reference belongs to non-cash tenders and cash received to cash: switching drops the other.
        return next.method === "CASH" ? { ...next, reference: "" } : { ...next, cashReceivedText: "" };
      }),
      checkout: this.#edited(),
    });
  }

  removeTender(rowId: string): void {
    if (this.#locked || this.#snapshot.tenders.length <= 1) return;
    this.#patch({
      tenders: this.#snapshot.tenders.filter((tender) => tender.rowId !== rowId),
      checkout: this.#edited(),
    });
  }

  /**
   * After TENDER_TOTAL_MISMATCH with a single tender: copies the total Tali
   * calculated into that tender's amount. Formatting only, no arithmetic.
   */
  useServerTotal(): void {
    const { serverTotal } = this.#snapshot.checkout;
    const currency = this.#snapshot.reference.currency;
    const [only] = this.#snapshot.tenders;
    if (this.#locked || serverTotal === undefined || currency === undefined || only === undefined) return;
    if (this.#snapshot.tenders.length !== 1) return;
    let text: string;
    try {
      text = Money.fromMinorUnitsString(serverTotal.amountMinor, currency.code).toDecimalString(currency);
    } catch {
      return;
    }
    this.updateTender(only.rowId, { amountText: text });
  }

  // ---- Recording a sale (keyed) ------------------------------------------

  /**
   * `POST .../sales` with a fresh UUIDv7 as both `saleId` and Idempotency-Key.
   * Only `saleId`, `lines` and `tenders` are sent. `allowDiscount` is the UX
   * affordance only; the API checks `sales:discount`.
   */
  async submitSale(allowDiscount: boolean): Promise<SalesOutcome<SaleResponse>> {
    if (this.#disposed || this.#locked) return IGNORED;
    const { currency, units } = this.#snapshot.reference;
    if (currency === undefined) return IGNORED;
    const draft = buildSalePayload({
      lines: this.#snapshot.lines,
      tenders: this.#snapshot.tenders,
      currency,
      unitFor: (code) => definitionFor(units, code),
      allowDiscount,
    });
    if (!draft.ok) {
      this.#patch({
        checkout: {
          ...this.#snapshot.checkout,
          failure: undefined,
          formError: draft.form,
          lineErrors: draft.lines,
          tenderErrors: draft.tenders,
        },
      });
      return IGNORED;
    }
    return this.#send(draft.payload);
  }

  /** Sends the unconfirmed sale again: the same body with the same key, so it is never recorded twice. */
  async resubmitSale(): Promise<SalesOutcome<SaleResponse>> {
    if (this.#disposed || this.#snapshot.checkout.phase !== "unconfirmed" || this.#pending === undefined) {
      return IGNORED;
    }
    return this.#send(this.#pending);
  }

  /** The person discards the unconfirmed sale to check Sales history; the cart is kept, the key is dropped. */
  discardUnconfirmedSale(): void {
    if (this.#snapshot.checkout.phase !== "unconfirmed") return;
    this.#sale.discard();
    this.#pending = undefined;
    this.#patch({ checkout: EDITING });
    void this.loadHistory();
  }

  /** Starts a new sale after a receipt was shown. */
  clearReceipt(): void {
    this.#patch({ receipt: undefined });
  }

  async #send(payload: SalePayload): Promise<SalesOutcome<SaleResponse>> {
    const begun = this.#sale.begin(payload);
    if (begun === "busy") return IGNORED;
    if (begun === "differs") return { status: "unconfirmed" };
    this.#pending = payload;
    const saleId = begun.key;
    this.#patch({
      checkout: { ...this.#snapshot.checkout, phase: "submitting", failure: undefined, ...NO_ERRORS, lineNotices: {} },
    });
    let outcome: SalesOutcome<SaleResponse>;
    let failure: ApiFailure | undefined = { kind: "unavailable", reason: "network" };
    try {
      outcome = await this.#request("business", (api, { token, device }) =>
        api.recordSale(token, this.#businessId, { saleId, lines: payload.lines, tenders: payload.tenders }, device),
      );
      if (outcome.status === "ok" && outcome.value.saleId !== saleId) {
        // A receipt for another sale cannot confirm this one.
        outcome = {
          status: "failed",
          failure: { kind: "invalid-response", status: 201, correlationId: undefined },
        };
      }
      failure = outcome.status === "ok" ? undefined : outcome.status === "failed" ? outcome.failure : failure;
    } finally {
      this.#sale.finish(failure);
    }
    if (this.#disposed) return IGNORED;
    if (this.#sale.unconfirmed) {
      this.#patch({ checkout: { ...this.#snapshot.checkout, phase: "unconfirmed" } });
      return outcome.status === "ok" ? IGNORED : { status: "unconfirmed" };
    }
    this.#pending = undefined;
    if (outcome.status === "ok") {
      this.#patch({
        lines: [],
        tenders: [this.#newTender("CASH")],
        checkout: EDITING,
        receipt: outcome.value,
        search: { query: "", phase: "idle", items: [], failure: undefined },
      });
      void this.loadHistory();
      return outcome;
    }
    if (outcome.status === "failed") this.#rejected(outcome.failure);
    else this.#patch({ checkout: { ...this.#snapshot.checkout, phase: "editing" } });
    return outcome;
  }

  /** A definite rejection: the key is over, the cart stays, and the API's guidance is shown per line. */
  #rejected(failure: ApiFailure): void {
    const { lines, reference } = this.#snapshot;
    const lineNotices: Record<string, string> = {};
    let nextLines = lines;
    let serverTotal: MoneyWire | undefined;
    const detail = failure.kind === "api-error" ? failure.sales : undefined;
    switch (detail?.code) {
      case "PRICE_CHANGED": {
        const changes = new Map(detail.details.changes.map((change) => [change.variantId, change]));
        nextLines = lines.map((line) => {
          const change = changes.get(line.variantId);
          if (change === undefined) return line;
          lineNotices[line.variantId] = "The price changed. Review the new price and submit again.";
          return {
            ...line,
            displayedPrice: { amountMinor: change.currentPriceMinor, currency: line.displayedPrice.currency },
            priceVersion: change.currentPriceVersion,
          };
        });
        break;
      }
      case "PRICE_NOT_SET":
        for (const variantId of detail.details.variantIds) lineNotices[variantId] = "Price not set";
        break;
      case "PRODUCT_ARCHIVED":
        for (const variantId of detail.details.variantIds) {
          lineNotices[variantId] = "This product is no longer available for sale.";
        }
        break;
      case "INSUFFICIENT_STOCK":
        for (const shortage of detail.details.shortages) {
          const line = lines.find((candidate) => candidate.variantId === shortage.variantId);
          if (line === undefined) continue;
          lineNotices[line.variantId] =
            `Available: ${formatQuantity({ quantityMinor: shortage.availableQuantityMinor, unit: line.stockUnit }, reference.units)}`;
        }
        break;
      case "DISCOUNT_EXCEEDS_LINE": {
        const line = lines[detail.details.lineNumber - 1];
        if (line !== undefined) lineNotices[line.variantId] = "The discount is more than this line's amount.";
        break;
      }
      case "TENDER_TOTAL_MISMATCH":
        if (reference.currency !== undefined) {
          serverTotal = { amountMinor: detail.details.serverTotalMinor, currency: reference.currency.code };
        }
        break;
      case undefined:
        break;
    }
    this.#patch({
      lines: nextLines,
      checkout: { phase: "editing", failure, serverTotal, ...NO_ERRORS, lineNotices },
    });
  }

  // ---- Sales history -----------------------------------------------------

  /** The first page of sales the caller may read, in the API's order. */
  async loadHistory(): Promise<void> {
    const generation = ++this.#historyGeneration;
    this.#patch({ history: emptyHistory() });
    const outcome = await this.#request("business", (api, { token, device }) =>
      api.listSales(token, this.#businessId, {}, device),
    );
    if (generation !== this.#historyGeneration || (outcome.status !== "ok" && outcome.status !== "failed")) return;
    const history = this.#snapshot.history;
    this.#patch({
      history:
        outcome.status === "failed"
          ? { ...history, phase: "failed", failure: outcome.failure }
          : {
              ...history,
              phase: "ready",
              items: appendUnique([], outcome.value.items),
              nextCursor: outcome.value.nextCursor,
            },
    });
  }

  async loadMoreHistory(): Promise<void> {
    const { nextCursor, phase, loadingMore } = this.#snapshot.history;
    if (nextCursor === null || phase !== "ready" || loadingMore) return;
    const generation = this.#historyGeneration;
    this.#patch({ history: { ...this.#snapshot.history, loadingMore: true, moreFailure: undefined } });
    const outcome = await this.#request("business", (api, { token, device }) =>
      api.listSales(token, this.#businessId, { after: nextCursor }, device),
    );
    if (generation !== this.#historyGeneration || this.#disposed) return;
    const history = this.#snapshot.history;
    if (outcome.status !== "ok" && outcome.status !== "failed") {
      this.#patch({ history: { ...history, loadingMore: false } });
      return;
    }
    this.#patch({
      history:
        outcome.status === "failed"
          ? { ...history, loadingMore: false, moreFailure: outcome.failure }
          : {
              ...history,
              loadingMore: false,
              items: appendUnique(history.items, outcome.value.items),
              nextCursor: outcome.value.nextCursor,
            },
    });
  }

  getSale(saleId: string): Promise<SalesOutcome<SaleResponse>> {
    return this.#request("resource", (api, { token, device }) => api.getSale(token, this.#businessId, saleId, device));
  }

  // ---- Reversal (keyed) --------------------------------------------------

  /**
   * `POST .../sales/:saleId/reversal` with its own fresh key. Sent only after
   * the person ticked the tender-unwound confirmation; an error correction,
   * not a refund or a return.
   */
  async reverseSale(saleId: string, reason: string): Promise<SalesOutcome<SaleResponse>> {
    if (this.#disposed) return IGNORED;
    const command = { saleId, reason };
    const begun = this.#reversal.begin(command);
    if (begun === "busy") return IGNORED;
    if (begun === "differs") return { status: "unconfirmed" };
    this.#patchReversal();
    let outcome: SalesOutcome<SaleResponse>;
    let failure: ApiFailure | undefined = { kind: "unavailable", reason: "network" };
    try {
      outcome = await this.#request("resource", (api, { token, device }) =>
        api.reverseSale(token, this.#businessId, saleId, { reason, tenderUnwoundConfirmed: true }, begun.key, device),
      );
      failure = outcome.status === "ok" ? undefined : outcome.status === "failed" ? outcome.failure : failure;
    } finally {
      this.#reversal.finish(failure);
      this.#patchReversal();
    }
    if (outcome.status === "ok") {
      const reversed = outcome.value;
      this.#patch({
        history: {
          ...this.#snapshot.history,
          items: this.#snapshot.history.items.map((sale) => (sale.saleId === reversed.saleId ? reversed : sale)),
        },
      });
    }
    return this.#reversal.unconfirmed && outcome.status !== "ok" ? { status: "unconfirmed" } : outcome;
  }

  discardUnconfirmedReversal(): void {
    this.#reversal.discard();
    this.#patchReversal();
  }

  /** A fresh reversal attempt (a new key) for the next sale opened. */
  resetReversal(): void {
    if (this.#reversal.inFlight) return;
    this.#reversal.discard();
    this.#patchReversal();
  }

  // ---- Internals ---------------------------------------------------------

  #edited(): CheckoutState {
    // Editing clears a previous rejection's form errors; the API's guidance stays until the next submission.
    return { ...this.#snapshot.checkout, ...NO_ERRORS };
  }

  #newTender(method: TenderMethod): TenderDraft {
    this.#tenderRows += 1;
    return { rowId: `tender-${this.#tenderRows}`, method, amountText: "", reference: "", cashReceivedText: "" };
  }

  #patchReversal(): void {
    this.#patch({ reversal: { inFlight: this.#reversal.inFlight, unconfirmed: this.#reversal.unconfirmed } });
  }

  async #request<T>(
    scope: BusinessRequestPolicy["notFoundScope"],
    send: (api: TaliApiClient, credentials: BusinessRequestCredentials) => Promise<ApiResult<T>>,
  ): Promise<SalesOutcome<T>> {
    if (this.#disposed) return IGNORED;
    const result = await this.#session.businessRequest(this.#businessId, { notFoundScope: scope }, send);
    if (this.#isDisposed()) return IGNORED;
    if (!("ok" in result)) {
      if (result.status === "businessUnavailable") this.#patch({ businessUnavailable: true });
      return IGNORED;
    }
    return result.ok ? { status: "ok", value: result.value } : { status: "failed", failure: result.failure };
  }

  /** Read through a method: `dispose()` can run while a request is awaited. */
  #isDisposed(): boolean {
    return this.#disposed;
  }

  #patch(changes: Partial<SalesSnapshot>): void {
    if (this.#disposed) return;
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...changes });
    for (const listener of this.#listeners) listener();
  }
}
