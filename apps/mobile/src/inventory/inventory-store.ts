import type {
  AdjustmentResponse,
  AdjustmentReversalResponse,
  CancelStocktakeRequest,
  CancelStocktakeResponse,
  ClearLowStockThresholdRequest,
  CreateStocktakeRequest,
  GoodsReceiptResponse,
  GoodsReceiptReversalResponse,
  InventoryItemResponse,
  InventoryMovementsResponse,
  LowStockThresholdResponse,
  OpeningBatchResponse,
  PackResponse,
  PostGoodsReceiptRequest,
  PostStocktakeRequest,
  PostStocktakeResponse,
  RecordAdjustmentRequest,
  RecordOpeningStockRequest,
  RecordStocktakeCountRequest,
  RecordWriteOffRequest,
  RemoveStocktakeLineRequest,
  ReverseDocumentRequest,
  SetLowStockThresholdRequest,
  StocktakeCreationResponse,
  StocktakeLineChangeResponse,
  StocktakeLineResponse,
  StocktakeResponse,
  UnitResponse,
} from "@tali/shared";
import type { ApiFailure, ApiResult, TaliApiClient } from "../api/tali-api-client";
import type { BusinessRequestCredentials, BusinessRequestPolicy, BusinessRequestResult } from "../auth/session-store";
import { KeyedCommand } from "./keyed-command";

/** The part of the session inventory uses: one request at a time for the selected business. */
export interface InventorySession {
  businessRequest<T>(
    businessId: string,
    policy: BusinessRequestPolicy,
    send: (api: TaliApiClient, credentials: BusinessRequestCredentials) => Promise<ApiResult<T>>,
  ): Promise<BusinessRequestResult<T>>;
}

export type LoadPhase = "loading" | "ready" | "failed";
export type StocktakeFilter = "ALL" | StocktakeResponse["status"];
export type KeyedOperation = "openingStock" | "goodsReceipt" | "adjustment" | "writeOff" | "createStocktake";

interface PagedList<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly phase: LoadPhase;
  readonly failure: ApiFailure | undefined;
  readonly loadingMore: boolean;
  /** A failed Show more keeps the loaded items; retrying uses the same cursor. */
  readonly moreFailure: ApiFailure | undefined;
}

export interface ItemListState extends PagedList<InventoryItemResponse> {
  /** The search term as sent (trimmed); empty means no `q`. */
  readonly query: string;
  /** Sent as `lowStock=true`; which items are low is decided by the API. */
  readonly lowStockOnly: boolean;
}

export interface StocktakeListState extends PagedList<StocktakeResponse> {
  readonly status: StocktakeFilter;
}

/**
 * What a picker or a stocktake line shows about a stock item. It has no
 * on-hand quantity, threshold or LOW STOCK flag, so counting screens built
 * from it cannot reveal the expected stock.
 */
export interface ItemLabel {
  readonly variantId: string;
  readonly productId: string;
  readonly name: string;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly productStatus: InventoryItemResponse["productStatus"];
  readonly stockUnit: string;
}

export interface KeyedState {
  readonly inFlight: boolean;
  /** An earlier submission's outcome is unknown: only the same details may be sent again, or it is discarded. */
  readonly unconfirmed: boolean;
}

/** Everything inventory components may render. It never holds a token, device credential or idempotency key. */
export interface InventorySnapshot {
  /** A business-level read answered NOT_FOUND; only the user's Switch business changes the selection. */
  readonly businessUnavailable: boolean;
  readonly units: {
    readonly phase: LoadPhase;
    readonly items: readonly UnitResponse[];
    readonly failure: ApiFailure | undefined;
  };
  readonly items: ItemListState;
  readonly stocktakes: StocktakeListState;
  /** Labels by variant ID for stocktake lines; `null` when the item is not available. */
  readonly labels: Readonly<Record<string, ItemLabel | null>>;
  readonly keyed: Readonly<Record<KeyedOperation, KeyedState>>;
}

export type InventoryOutcome<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "failed"; readonly failure: ApiFailure }
  /** A keyed submission whose earlier outcome is unknown was changed; it must be resent unchanged or discarded. */
  | { readonly status: "unconfirmed" }
  /** Superseded, disposed, a submission already in flight, or handled by the session or business state. */
  | { readonly status: "ignored" };

export interface StocktakeLines {
  readonly lines: readonly StocktakeLineResponse[];
  /** Not every line could be listed (page cap, repeated cursor or an empty page with a cursor). */
  readonly truncated: boolean;
}

export interface InventoryStoreOptions {
  readonly businessId: string;
  readonly session: InventorySession;
  /** The approved client UUID implementation (RFC 9562 UUIDv7), used for Idempotency-Key values. */
  readonly newIdempotencyKey: () => string;
}

export const STOCKTAKE_LINE_PAGE_SIZE = 100;
export const STOCKTAKE_LINE_MAX_PAGES = 10;
const PICKER_PAGE_SIZE = 20;
const PACK_PAGE_SIZE = 100;

const IGNORED: { readonly status: "ignored" } = Object.freeze({ status: "ignored" });
const KEYED_OPERATIONS: readonly KeyedOperation[] = [
  "openingStock",
  "goodsReceipt",
  "adjustment",
  "writeOff",
  "createStocktake",
];

function emptyList<T>(): PagedList<T> {
  return {
    items: [],
    nextCursor: null,
    phase: "loading",
    failure: undefined,
    loadingMore: false,
    moreFailure: undefined,
  };
}

function appendUnique<T>(existing: readonly T[], page: readonly T[], id: (item: T) => string): T[] {
  const seen = new Set(existing.map(id));
  return [...existing, ...page.filter((item) => !seen.has(id(item)))];
}

export function itemLabel(item: InventoryItemResponse): ItemLabel {
  return {
    variantId: item.variantId,
    productId: item.productId,
    name: item.name,
    sku: item.sku,
    barcode: item.barcode,
    productStatus: item.productStatus,
    stockUnit: item.stockUnit,
  };
}

/**
 * Inventory state for one selected business (plan 004 Slice 7), in memory
 * only. Created when the Inventory section mounts and disposed when it
 * unmounts, so a business switch or sign-out drops everything. Every request
 * goes through `InventorySession.businessRequest`, which supplies the token
 * and this business's device headers for that one request; this store never keeps them. The API is authoritative for balances, LOW STOCK,
 * variances, permissions and idempotency: after a change this store reloads
 * what the API returns and never edits a balance itself.
 */
export class InventoryStore {
  readonly #businessId: string;
  readonly #session: InventorySession;
  readonly #listeners = new Set<() => void>();
  readonly #keyed: Readonly<Record<KeyedOperation, KeyedCommand<unknown>>>;
  readonly #labelRequests = new Set<string>();
  #snapshot: InventorySnapshot;
  #disposed = false;
  #itemGeneration = 0;
  #stocktakeGeneration = 0;
  #unitsGeneration = 0;

  constructor(options: InventoryStoreOptions) {
    this.#businessId = options.businessId;
    this.#session = options.session;
    const newKey = options.newIdempotencyKey;
    this.#keyed = {
      openingStock: new KeyedCommand(newKey),
      goodsReceipt: new KeyedCommand(newKey),
      adjustment: new KeyedCommand(newKey),
      writeOff: new KeyedCommand(newKey),
      createStocktake: new KeyedCommand(newKey),
    };
    this.#snapshot = Object.freeze<InventorySnapshot>({
      businessUnavailable: false,
      units: { phase: "loading", items: [], failure: undefined },
      items: { ...emptyList<InventoryItemResponse>(), query: "", lowStockOnly: false },
      stocktakes: { ...emptyList<StocktakeResponse>(), status: "ALL" },
      labels: {},
      keyed: this.#keyedState(),
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): InventorySnapshot => this.#snapshot;

  get businessId(): string {
    return this.#businessId;
  }

  /** Loads the units and the first page of stock items. */
  start(): void {
    void this.loadUnits();
    void this.searchItems("", false);
  }

  /** Ignores every later result and forgets all idempotency attempts. */
  dispose(): void {
    this.#disposed = true;
    for (const operation of KEYED_OPERATIONS) this.#keyed[operation].reset();
    this.#listeners.clear();
  }

  // ---- Units (business scope) --------------------------------------------

  async loadUnits(): Promise<void> {
    const generation = ++this.#unitsGeneration;
    this.#patch({ units: { ...this.#snapshot.units, phase: "loading", failure: undefined } });
    const outcome = await this.#request("business", (api, { token, device }) =>
      api.listUnits(token, this.#businessId, device),
    );
    if (generation !== this.#unitsGeneration || outcome.status !== "ok") {
      if (generation === this.#unitsGeneration && outcome.status === "failed") {
        this.#patch({ units: { phase: "failed", items: [], failure: outcome.failure } });
      }
      return;
    }
    this.#patch({ units: { phase: "ready", items: outcome.value.items, failure: undefined } });
  }

  // ---- Stock list (business scope) ---------------------------------------

  /** A new search or filter: the cursor resets and the results are replaced. */
  async searchItems(query: string, lowStockOnly: boolean): Promise<void> {
    const q = query.trim();
    const generation = ++this.#itemGeneration;
    this.#patch({ items: { ...emptyList<InventoryItemResponse>(), query: q, lowStockOnly } });
    const outcome = await this.#request("business", (api, { token, device }) =>
      api.listInventoryItems(
        token,
        this.#businessId,
        {
          ...(q === "" ? {} : { q }),
          ...(lowStockOnly ? { lowStock: true } : {}),
        },
        device,
      ),
    );
    if (generation !== this.#itemGeneration || outcome.status === "ignored" || outcome.status === "unconfirmed") return;
    const items = this.#snapshot.items;
    this.#patch({
      items:
        outcome.status === "failed"
          ? { ...items, phase: "failed", failure: outcome.failure }
          : { ...items, phase: "ready", items: outcome.value.items, nextCursor: outcome.value.nextCursor },
    });
  }

  refreshItems(): Promise<void> {
    const { query, lowStockOnly } = this.#snapshot.items;
    return this.searchItems(query, lowStockOnly);
  }

  async loadMoreItems(): Promise<void> {
    const { nextCursor, query, lowStockOnly, phase, loadingMore } = this.#snapshot.items;
    if (nextCursor === null || phase !== "ready" || loadingMore) return;
    const generation = this.#itemGeneration;
    this.#patch({ items: { ...this.#snapshot.items, loadingMore: true, moreFailure: undefined } });
    const outcome = await this.#request("business", (api, { token, device }) =>
      api.listInventoryItems(
        token,
        this.#businessId,
        {
          after: nextCursor,
          ...(query === "" ? {} : { q: query }),
          ...(lowStockOnly ? { lowStock: true } : {}),
        },
        device,
      ),
    );
    if (generation !== this.#itemGeneration || this.#disposed) return;
    const items = this.#snapshot.items;
    if (outcome.status !== "ok" && outcome.status !== "failed") {
      this.#patch({ items: { ...items, loadingMore: false } });
      return;
    }
    this.#patch({
      items:
        outcome.status === "failed"
          ? { ...items, loadingMore: false, moreFailure: outcome.failure }
          : {
              ...items,
              loadingMore: false,
              items: appendUnique(items.items, outcome.value.items, (item) => item.variantId),
              nextCursor: outcome.value.nextCursor,
            },
    });
  }

  /** Items for a picker: labels only, never quantities. */
  async findItems(query: string): Promise<InventoryOutcome<readonly ItemLabel[]>> {
    const q = query.trim();
    const outcome = await this.#request("business", (api, { token, device }) =>
      api.listInventoryItems(token, this.#businessId, { limit: PICKER_PAGE_SIZE, ...(q === "" ? {} : { q }) }, device),
    );
    return outcome.status === "ok" ? { status: "ok", value: outcome.value.items.map(itemLabel) } : outcome;
  }

  // ---- One item (resource scope) -----------------------------------------

  getItem(variantId: string): Promise<InventoryOutcome<InventoryItemResponse>> {
    return this.#request("resource", (api, { token, device }) =>
      api.getInventoryItem(token, this.#businessId, variantId, device),
    );
  }

  listMovements(variantId: string, after?: string): Promise<InventoryOutcome<InventoryMovementsResponse>> {
    return this.#request("resource", (api, { token, device }) =>
      api.listInventoryMovements(token, this.#businessId, variantId, after === undefined ? {} : { after }, device),
    );
  }

  /** ACTIVE packs of the item's product, for pack entry (first 100). */
  async listPacks(productId: string): Promise<InventoryOutcome<readonly PackResponse[]>> {
    const outcome = await this.#request("resource", (api, { token, device }) =>
      api.listPacks(token, this.#businessId, productId, { status: "ACTIVE", limit: PACK_PAGE_SIZE }, device),
    );
    return outcome.status === "ok" ? { status: "ok", value: outcome.value.items } : outcome;
  }

  /**
   * Loads labels for stocktake lines that have none yet. Only the label is
   * kept; the rest of the item response is dropped here.
   */
  async ensureLabels(variantIds: readonly string[]): Promise<void> {
    const missing = variantIds.filter((id) => !(id in this.#snapshot.labels) && !this.#labelRequests.has(id));
    for (const id of missing) this.#labelRequests.add(id);
    for (const id of missing) {
      const outcome = await this.#request("resource", (api, { token, device }) =>
        api.getInventoryItem(token, this.#businessId, id, device),
      );
      this.#labelRequests.delete(id);
      if (outcome.status === "ok") {
        this.#patch({ labels: { ...this.#snapshot.labels, [id]: itemLabel(outcome.value) } });
      } else if (
        outcome.status === "failed" &&
        outcome.failure.kind === "api-error" &&
        outcome.failure.code === "NOT_FOUND"
      ) {
        this.#patch({ labels: { ...this.#snapshot.labels, [id]: null } });
      }
    }
  }

  rememberLabel(label: ItemLabel): void {
    this.#patch({ labels: { ...this.#snapshot.labels, [label.variantId]: label } });
  }

  // ---- Stock documents ---------------------------------------------------

  async recordOpeningStock(command: RecordOpeningStockRequest): Promise<InventoryOutcome<OpeningBatchResponse>> {
    return this.#afterStockChange(
      await this.#keyedSubmit("openingStock", command, (api, { token, device }, key) =>
        api.recordOpeningStock(token, this.#businessId, command, key, device),
      ),
    );
  }

  async postGoodsReceipt(command: PostGoodsReceiptRequest): Promise<InventoryOutcome<GoodsReceiptResponse>> {
    return this.#afterStockChange(
      await this.#keyedSubmit("goodsReceipt", command, (api, { token, device }, key) =>
        api.postGoodsReceipt(token, this.#businessId, command, key, device),
      ),
    );
  }

  async recordAdjustment(command: RecordAdjustmentRequest): Promise<InventoryOutcome<AdjustmentResponse>> {
    return this.#afterStockChange(
      await this.#keyedSubmit("adjustment", command, (api, { token, device }, key) =>
        api.recordAdjustment(token, this.#businessId, command, key, device),
      ),
    );
  }

  async recordWriteOff(command: RecordWriteOffRequest): Promise<InventoryOutcome<AdjustmentResponse>> {
    return this.#afterStockChange(
      await this.#keyedSubmit("writeOff", command, (api, { token, device }, key) =>
        api.recordWriteOff(token, this.#businessId, command, key, device),
      ),
    );
  }

  /** The person discards an unconfirmed submission; the next one gets a new Idempotency-Key. */
  discardUnconfirmed(operation: KeyedOperation): void {
    this.#keyed[operation].discard();
    this.#patch({ keyed: this.#keyedState() });
  }

  getOpeningBatch(id: string): Promise<InventoryOutcome<OpeningBatchResponse>> {
    return this.#request("resource", (api, { token, device }) =>
      api.getOpeningBatch(token, this.#businessId, id, device),
    );
  }

  getGoodsReceipt(id: string): Promise<InventoryOutcome<GoodsReceiptResponse>> {
    return this.#request("resource", (api, { token, device }) =>
      api.getGoodsReceipt(token, this.#businessId, id, device),
    );
  }

  getAdjustment(id: string): Promise<InventoryOutcome<AdjustmentResponse>> {
    return this.#request("resource", (api, { token, device }) =>
      api.getAdjustment(token, this.#businessId, id, device),
    );
  }

  async reverseGoodsReceipt(
    id: string,
    command: ReverseDocumentRequest,
  ): Promise<InventoryOutcome<GoodsReceiptReversalResponse>> {
    return this.#afterStockChange(
      await this.#request("resource", (api, { token, device }) =>
        api.reverseGoodsReceipt(token, this.#businessId, id, command, device),
      ),
    );
  }

  async reverseAdjustment(
    id: string,
    command: ReverseDocumentRequest,
  ): Promise<InventoryOutcome<AdjustmentReversalResponse>> {
    return this.#afterStockChange(
      await this.#request("resource", (api, { token, device }) =>
        api.reverseAdjustment(token, this.#businessId, id, command, device),
      ),
    );
  }

  // ---- Low-stock threshold -----------------------------------------------

  async setThreshold(
    variantId: string,
    command: SetLowStockThresholdRequest,
  ): Promise<InventoryOutcome<LowStockThresholdResponse>> {
    return this.#afterStockChange(
      await this.#request("resource", (api, { token, device }) =>
        api.setLowStockThreshold(token, this.#businessId, variantId, command, device),
      ),
    );
  }

  async clearThreshold(
    variantId: string,
    command: ClearLowStockThresholdRequest,
  ): Promise<InventoryOutcome<LowStockThresholdResponse>> {
    return this.#afterStockChange(
      await this.#request("resource", (api, { token, device }) =>
        api.clearLowStockThreshold(token, this.#businessId, variantId, command, device),
      ),
    );
  }

  // ---- Stocktakes --------------------------------------------------------

  async loadStocktakes(status: StocktakeFilter): Promise<void> {
    const generation = ++this.#stocktakeGeneration;
    this.#patch({ stocktakes: { ...emptyList<StocktakeResponse>(), status } });
    const outcome = await this.#request("business", (api, { token, device }) =>
      api.listStocktakes(token, this.#businessId, status === "ALL" ? {} : { status }, device),
    );
    if (generation !== this.#stocktakeGeneration || (outcome.status !== "ok" && outcome.status !== "failed")) return;
    const stocktakes = this.#snapshot.stocktakes;
    this.#patch({
      stocktakes:
        outcome.status === "failed"
          ? { ...stocktakes, phase: "failed", failure: outcome.failure }
          : { ...stocktakes, phase: "ready", items: outcome.value.items, nextCursor: outcome.value.nextCursor },
    });
  }

  refreshStocktakes(): Promise<void> {
    return this.loadStocktakes(this.#snapshot.stocktakes.status);
  }

  async loadMoreStocktakes(): Promise<void> {
    const { nextCursor, status, phase, loadingMore } = this.#snapshot.stocktakes;
    if (nextCursor === null || phase !== "ready" || loadingMore) return;
    const generation = this.#stocktakeGeneration;
    this.#patch({ stocktakes: { ...this.#snapshot.stocktakes, loadingMore: true, moreFailure: undefined } });
    const outcome = await this.#request("business", (api, { token, device }) =>
      api.listStocktakes(
        token,
        this.#businessId,
        { after: nextCursor, ...(status === "ALL" ? {} : { status }) },
        device,
      ),
    );
    if (generation !== this.#stocktakeGeneration || this.#disposed) return;
    const stocktakes = this.#snapshot.stocktakes;
    if (outcome.status !== "ok" && outcome.status !== "failed") {
      this.#patch({ stocktakes: { ...stocktakes, loadingMore: false } });
      return;
    }
    this.#patch({
      stocktakes:
        outcome.status === "failed"
          ? { ...stocktakes, loadingMore: false, moreFailure: outcome.failure }
          : {
              ...stocktakes,
              loadingMore: false,
              items: appendUnique(stocktakes.items, outcome.value.items, (item) => item.stocktakeId),
              nextCursor: outcome.value.nextCursor,
            },
    });
  }

  /** Keyed. CONFLICT means a DRAFT stocktake already exists; `findDraftStocktake` locates it. */
  async createStocktake(command: CreateStocktakeRequest): Promise<InventoryOutcome<StocktakeCreationResponse>> {
    const outcome = await this.#keyedSubmit("createStocktake", command, (api, { token, device }, key) =>
      api.createStocktake(token, this.#businessId, command, key, device),
    );
    if (outcome.status === "ok") void this.refreshStocktakes();
    return outcome;
  }

  /** The stocktake in progress, if any: the first DRAFT the API lists. */
  async findDraftStocktake(): Promise<InventoryOutcome<StocktakeResponse | undefined>> {
    const outcome = await this.#request("business", (api, { token, device }) =>
      api.listStocktakes(token, this.#businessId, { status: "DRAFT", limit: 1 }, device),
    );
    return outcome.status === "ok" ? { status: "ok", value: outcome.value.items[0] } : outcome;
  }

  getStocktake(stocktakeId: string): Promise<InventoryOutcome<StocktakeResponse>> {
    return this.#request("resource", (api, { token, device }) =>
      api.getStocktake(token, this.#businessId, stocktakeId, device),
    );
  }

  /**
   * Every line, in pages of 100 and at most STOCKTAKE_LINE_MAX_PAGES, so a
   * recount sends the version of the line as last read. A repeated cursor, an
   * empty page with a cursor or the page cap marks the result truncated.
   */
  async loadStocktakeLines(stocktakeId: string): Promise<InventoryOutcome<StocktakeLines>> {
    let lines: StocktakeLineResponse[] = [];
    const seenCursors = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < STOCKTAKE_LINE_MAX_PAGES; page += 1) {
      const cursor = after;
      const outcome = await this.#request("resource", (api, { token, device }) =>
        api.listStocktakeLines(
          token,
          this.#businessId,
          stocktakeId,
          {
            limit: STOCKTAKE_LINE_PAGE_SIZE,
            ...(cursor === undefined ? {} : { after: cursor }),
          },
          device,
        ),
      );
      if (outcome.status !== "ok") return outcome;
      lines = appendUnique(lines, outcome.value.items, (line) => line.variantId);
      const next = outcome.value.nextCursor;
      if (next === null) return { status: "ok", value: { lines, truncated: false } };
      if (seenCursors.has(next) || outcome.value.items.length === 0) break;
      seenCursors.add(next);
      after = next;
    }
    return { status: "ok", value: { lines, truncated: true } };
  }

  recordCount(
    stocktakeId: string,
    variantId: string,
    command: RecordStocktakeCountRequest,
  ): Promise<InventoryOutcome<StocktakeLineChangeResponse>> {
    return this.#request("resource", (api, { token, device }) =>
      api.recordStocktakeCount(token, this.#businessId, stocktakeId, variantId, command, device),
    );
  }

  removeLine(
    stocktakeId: string,
    variantId: string,
    command: RemoveStocktakeLineRequest,
  ): Promise<InventoryOutcome<StocktakeLineChangeResponse>> {
    return this.#request("resource", (api, { token, device }) =>
      api.removeStocktakeLine(token, this.#businessId, stocktakeId, variantId, command, device),
    );
  }

  /** A POSTED stocktake answers its posted result (`changed: false`), which is a success. */
  async postStocktake(
    stocktakeId: string,
    command: PostStocktakeRequest,
  ): Promise<InventoryOutcome<PostStocktakeResponse>> {
    const outcome = await this.#request("resource", (api, { token, device }) =>
      api.postStocktake(token, this.#businessId, stocktakeId, command, device),
    );
    if (outcome.status === "ok") {
      void this.refreshItems();
      void this.refreshStocktakes();
    }
    return outcome;
  }

  async cancelStocktake(
    stocktakeId: string,
    command: CancelStocktakeRequest,
  ): Promise<InventoryOutcome<CancelStocktakeResponse>> {
    const outcome = await this.#request("resource", (api, { token, device }) =>
      api.cancelStocktake(token, this.#businessId, stocktakeId, command, device),
    );
    if (outcome.status === "ok") void this.refreshStocktakes();
    return outcome;
  }

  // ---- Internals ---------------------------------------------------------

  /** Stock or a threshold changed: the list is reloaded from the API, never edited locally. */
  #afterStockChange<T>(outcome: InventoryOutcome<T>): InventoryOutcome<T> {
    if (outcome.status === "ok") void this.refreshItems();
    return outcome;
  }

  async #keyedSubmit<T>(
    operation: KeyedOperation,
    command: unknown,
    send: (api: TaliApiClient, credentials: BusinessRequestCredentials, key: string) => Promise<ApiResult<T>>,
  ): Promise<InventoryOutcome<T>> {
    if (this.#disposed) return IGNORED;
    const submission = this.#keyed[operation];
    const begun = submission.begin(command);
    if (begun === "busy") return IGNORED;
    if (begun === "differs") return { status: "unconfirmed" };
    this.#patch({ keyed: this.#keyedState() });
    let outcome: InventoryOutcome<T> = IGNORED;
    try {
      outcome = await this.#request("resource", (api, credentials) => send(api, credentials, begun.key));
    } finally {
      // Session-level handling (signed out, business unavailable) ends the attempt with an unknown outcome.
      submission.finish(
        outcome.status === "ok"
          ? undefined
          : outcome.status === "failed"
            ? outcome.failure
            : { kind: "unavailable", reason: "network" },
      );
      this.#patch({ keyed: this.#keyedState() });
    }
    return outcome;
  }

  #keyedState(): Readonly<Record<KeyedOperation, KeyedState>> {
    const state = {} as Record<KeyedOperation, KeyedState>;
    for (const operation of KEYED_OPERATIONS) {
      const submission = this.#keyed[operation];
      state[operation] = { inFlight: submission.inFlight, unconfirmed: submission.unconfirmed };
    }
    return state;
  }

  async #request<T>(
    scope: BusinessRequestPolicy["notFoundScope"],
    send: (api: TaliApiClient, credentials: BusinessRequestCredentials) => Promise<ApiResult<T>>,
  ): Promise<InventoryOutcome<T>> {
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

  #patch(changes: Partial<InventorySnapshot>): void {
    if (this.#disposed) return;
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...changes });
    for (const listener of this.#listeners) listener();
  }
}
