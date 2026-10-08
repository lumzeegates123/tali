import type { CurrencyDefinition } from "@tali/domain/kernel";
import type {
  ArchiveProductRequest,
  CategoryResponse,
  CreateProductRequest,
  ProductResponse,
  ReactivateProductRequest,
  SetSellingPriceRequest,
  UnitResponse,
  UpdateProductRequest,
} from "@tali/shared";
import type { ApiFailure, ApiResult, TaliApiClient } from "../api/tali-api-client";
import type { BusinessRequestCredentials, BusinessRequestPolicy, BusinessRequestResult } from "../auth/session-store";
import { KeyedSubmission, sameCreateProduct } from "./keyed-submission";
import { currencyDefinition } from "./money-format";

/** The part of the session the catalog uses: one request at a time for the selected business. */
export interface CatalogSession {
  businessRequest<T>(
    businessId: string,
    policy: BusinessRequestPolicy,
    send: (api: TaliApiClient, credentials: BusinessRequestCredentials) => Promise<ApiResult<T>>,
  ): Promise<BusinessRequestResult<T>>;
}

export type CatalogStatus = "ACTIVE" | "ARCHIVED";
export type LoadPhase = "loading" | "ready" | "failed";

export interface ProductListState {
  /** The search term as sent (trimmed); empty means no `q`. It matches name, SKU or barcode. */
  readonly query: string;
  readonly status: CatalogStatus;
  readonly items: readonly ProductResponse[];
  readonly nextCursor: string | null;
  readonly phase: LoadPhase;
  readonly failure: ApiFailure | undefined;
  readonly loadingMore: boolean;
  /** A failed Show more keeps the loaded items; retrying uses the same cursor. */
  readonly moreFailure: ApiFailure | undefined;
}

export interface ReferenceState {
  readonly phase: LoadPhase;
  readonly currency: CurrencyDefinition | undefined;
  readonly units: readonly UnitResponse[];
  readonly failure: ApiFailure | undefined;
}

export interface CategoryOptionsState {
  readonly phase: LoadPhase;
  /** ACTIVE categories, read-only on mobile, in API order. */
  readonly items: readonly CategoryResponse[];
  /** Not every category could be listed (page cap, repeated cursor, empty page or a failed page). */
  readonly truncated: boolean;
  readonly failure: ApiFailure | undefined;
}

/** Everything catalog screens may render. It never holds a token, device credential or idempotency key. */
export interface CatalogSnapshot {
  /** A business-level read answered NOT_FOUND; only the user's Switch business changes the selection. */
  readonly businessUnavailable: boolean;
  readonly reference: ReferenceState;
  readonly products: ProductListState;
  readonly categoryOptions: CategoryOptionsState;
  readonly submitting: { readonly createProduct: boolean };
}

export type CatalogOutcome<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "failed"; readonly failure: ApiFailure }
  /** Superseded, disposed, a submission already in flight, or handled by the session or business state. */
  | { readonly status: "ignored" };

export interface CatalogStoreOptions {
  readonly businessId: string;
  readonly session: CatalogSession;
  /** The approved client UUID implementation (RFC 9562 UUIDv7), used for Idempotency-Key values. */
  readonly newIdempotencyKey: () => string;
}

export const CATEGORY_OPTION_PAGE_SIZE = 100;
export const CATEGORY_OPTION_MAX_PAGES = 10;

const IGNORED: { readonly status: "ignored" } = Object.freeze({ status: "ignored" });

function emptyProducts(query: string, status: CatalogStatus): ProductListState {
  return {
    query,
    status,
    items: [],
    nextCursor: null,
    phase: "loading",
    failure: undefined,
    loadingMore: false,
    moreFailure: undefined,
  };
}

function appendUnique<T extends { readonly id: string }>(existing: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(existing.map((item) => item.id));
  return [...existing, ...page.filter((item) => !seen.has(item.id))];
}

function isApiError(failure: ApiFailure, code: string): boolean {
  return failure.kind === "api-error" && failure.code === code;
}

/**
 * Catalog state for one selected business (plan 004 Slice 4), in memory only.
 * Created when the catalog section mounts and disposed when it unmounts, so a
 * business switch or sign-out drops everything. Every request goes through
 * `CatalogSession.businessRequest`, which supplies the token and this
 * business's device headers for that one request; this store never keeps
 * them. The API stays authoritative for permissions, tenancy, validation and
 * idempotency.
 */
export class CatalogStore {
  readonly #businessId: string;
  readonly #session: CatalogSession;
  readonly #listeners = new Set<() => void>();
  readonly #createProduct: KeyedSubmission<CreateProductRequest>;
  #snapshot: CatalogSnapshot;
  #disposed = false;
  #productGeneration = 0;
  #optionsGeneration = 0;
  #referenceGeneration = 0;

  constructor(options: CatalogStoreOptions) {
    this.#businessId = options.businessId;
    this.#session = options.session;
    this.#createProduct = new KeyedSubmission(sameCreateProduct, options.newIdempotencyKey);
    this.#snapshot = Object.freeze<CatalogSnapshot>({
      businessUnavailable: false,
      reference: { phase: "loading", currency: undefined, units: [], failure: undefined },
      products: emptyProducts("", "ACTIVE"),
      categoryOptions: { phase: "loading", items: [], truncated: false, failure: undefined },
      submitting: { createProduct: false },
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): CatalogSnapshot => this.#snapshot;

  /** Loads the reference data, the first ACTIVE product page and the category options. */
  start(): void {
    void this.loadReference();
    void this.searchProducts("", "ACTIVE");
    void this.loadCategoryOptions();
  }

  /** Ignores every later result and forgets the idempotency attempt. */
  dispose(): void {
    this.#disposed = true;
    this.#createProduct.reset();
    this.#listeners.clear();
  }

  /** `GET .../currency` and `GET .../catalog/units`, once per business (and on retry). */
  async loadReference(): Promise<void> {
    const generation = ++this.#referenceGeneration;
    this.#patch({ reference: { ...this.#snapshot.reference, phase: "loading", failure: undefined } });
    const [currency, units] = await Promise.all([
      this.#request("business", (api, { token, device }) => api.getBusinessCurrency(token, this.#businessId, device)),
      this.#request("business", (api, { token, device }) => api.listUnits(token, this.#businessId, device)),
    ]);
    if (generation !== this.#referenceGeneration || currency.status === "ignored" || units.status === "ignored") {
      return;
    }
    if (currency.status === "failed" || units.status === "failed") {
      const failure =
        currency.status === "failed" ? currency.failure : units.status === "failed" ? units.failure : undefined;
      this.#patch({ reference: { phase: "failed", currency: undefined, units: [], failure } });
      return;
    }
    const definition = currencyDefinition(currency.value);
    if (definition === undefined) {
      this.#patch({
        reference: {
          phase: "failed",
          currency: undefined,
          units: [],
          failure: { kind: "invalid-response", status: 200, correlationId: undefined },
        },
      });
      return;
    }
    this.#patch({ reference: { phase: "ready", currency: definition, units: units.value.items, failure: undefined } });
  }

  /** A new search or status: the cursor resets and the results are replaced. `q` is sent only when not blank. */
  async searchProducts(query: string, status: CatalogStatus): Promise<void> {
    const q = query.trim();
    const generation = ++this.#productGeneration;
    this.#patch({ products: emptyProducts(q, status) });
    const outcome = await this.#request("business", (api, { token, device }) =>
      api.listProducts(token, this.#businessId, { status, ...(q === "" ? {} : { q }) }, device),
    );
    if (generation !== this.#productGeneration || outcome.status === "ignored") return;
    const products = this.#snapshot.products;
    this.#patch({
      products:
        outcome.status === "failed"
          ? { ...products, phase: "failed", failure: outcome.failure }
          : { ...products, phase: "ready", items: outcome.value.items, nextCursor: outcome.value.nextCursor },
    });
  }

  refreshProducts(): Promise<void> {
    const { query, status } = this.#snapshot.products;
    return this.searchProducts(query, status);
  }

  /** Show more: the same query and status from `nextCursor`; appended items are de-duplicated by ID. */
  async loadMoreProducts(): Promise<void> {
    const { nextCursor, query, status, phase, loadingMore } = this.#snapshot.products;
    if (nextCursor === null || phase !== "ready" || loadingMore) return;
    const generation = this.#productGeneration;
    this.#patch({ products: { ...this.#snapshot.products, loadingMore: true, moreFailure: undefined } });
    const outcome = await this.#request("business", (api, { token, device }) =>
      api.listProducts(
        token,
        this.#businessId,
        { status, after: nextCursor, ...(query === "" ? {} : { q: query }) },
        device,
      ),
    );
    if (generation !== this.#productGeneration || this.#isDisposed()) return;
    const products = this.#snapshot.products;
    if (outcome.status === "ignored") {
      this.#patch({ products: { ...products, loadingMore: false } });
      return;
    }
    this.#patch({
      products:
        outcome.status === "failed"
          ? { ...products, loadingMore: false, moreFailure: outcome.failure }
          : {
              ...products,
              loadingMore: false,
              items: appendUnique(products.items, outcome.value.items),
              nextCursor: outcome.value.nextCursor,
            },
    });
  }

  getProduct(productId: string): Promise<CatalogOutcome<ProductResponse>> {
    return this.#request("resource", (api, { token, device }) =>
      api.getProduct(token, this.#businessId, productId, device),
    );
  }

  /** Keyed create: retrying the unchanged command after an unknown outcome reuses its key. */
  async createProduct(command: CreateProductRequest): Promise<CatalogOutcome<ProductResponse>> {
    if (this.#disposed) return IGNORED;
    const key = this.#createProduct.begin(command);
    if (key === undefined) return IGNORED;
    this.#patch({ submitting: { createProduct: true } });
    let outcome: CatalogOutcome<ProductResponse> = IGNORED;
    try {
      outcome = await this.#request("resource", (api, { token, device }) =>
        api.createProduct(token, this.#businessId, command, key, device),
      );
    } finally {
      this.#createProduct.finish(
        outcome.status === "ok"
          ? "succeeded"
          : outcome.status === "failed" && isApiError(outcome.failure, "IDEMPOTENCY_KEY_REUSED")
            ? "keyReused"
            : "failed",
      );
      this.#patch({ submitting: { createProduct: false } });
    }
    if (outcome.status === "ok") void this.refreshProducts();
    return outcome;
  }

  async updateProduct(productId: string, command: UpdateProductRequest): Promise<CatalogOutcome<ProductResponse>> {
    return this.#productChange(
      await this.#request("resource", (api, { token, device }) =>
        api.updateProduct(token, this.#businessId, productId, command, device),
      ),
    );
  }

  async archiveProduct(productId: string, command: ArchiveProductRequest): Promise<CatalogOutcome<ProductResponse>> {
    return this.#productChange(
      await this.#request("resource", (api, { token, device }) =>
        api.archiveProduct(token, this.#businessId, productId, command, device),
      ),
    );
  }

  async reactivateProduct(
    productId: string,
    command: ReactivateProductRequest,
  ): Promise<CatalogOutcome<ProductResponse>> {
    return this.#productChange(
      await this.#request("resource", (api, { token, device }) =>
        api.reactivateProduct(token, this.#businessId, productId, command, device),
      ),
    );
  }

  async setSellingPrice(productId: string, command: SetSellingPriceRequest): Promise<CatalogOutcome<ProductResponse>> {
    return this.#productChange(
      await this.#request("resource", (api, { token, device }) =>
        api.setSellingPrice(token, this.#businessId, productId, command, device),
      ),
    );
  }

  /**
   * ACTIVE categories for the product form: pages of 100, at most
   * CATEGORY_OPTION_MAX_PAGES. A repeated cursor, an empty page that still has
   * a cursor, a failed later page or the page cap stops the loop and marks
   * the options truncated; loaded options stay usable.
   */
  async loadCategoryOptions(): Promise<void> {
    const generation = ++this.#optionsGeneration;
    this.#patch({ categoryOptions: { phase: "loading", items: [], truncated: false, failure: undefined } });
    let items: CategoryResponse[] = [];
    const seenCursors = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < CATEGORY_OPTION_MAX_PAGES; page += 1) {
      const cursor = after;
      const outcome = await this.#request("business", (api, { token, device }) =>
        api.listCategories(
          token,
          this.#businessId,
          { status: "ACTIVE", limit: CATEGORY_OPTION_PAGE_SIZE, ...(cursor === undefined ? {} : { after: cursor }) },
          device,
        ),
      );
      if (generation !== this.#optionsGeneration || outcome.status === "ignored") return;
      if (outcome.status === "failed") {
        this.#patch({
          categoryOptions:
            items.length === 0
              ? { phase: "failed", items: [], truncated: false, failure: outcome.failure }
              : { phase: "ready", items, truncated: true, failure: undefined },
        });
        return;
      }
      items = appendUnique(items, outcome.value.items);
      const next = outcome.value.nextCursor;
      if (next === null) {
        this.#patch({ categoryOptions: { phase: "ready", items, truncated: false, failure: undefined } });
        return;
      }
      if (seenCursors.has(next) || outcome.value.items.length === 0) break;
      seenCursors.add(next);
      after = next;
    }
    this.#patch({ categoryOptions: { phase: "ready", items, truncated: true, failure: undefined } });
  }

  getCategory(categoryId: string): Promise<CatalogOutcome<CategoryResponse>> {
    return this.#request("resource", (api, { token, device }) =>
      api.getCategory(token, this.#businessId, categoryId, device),
    );
  }

  /** A changed product replaces its row; a row whose status no longer matches the filter is removed. */
  #productChange(outcome: CatalogOutcome<ProductResponse>): CatalogOutcome<ProductResponse> {
    if (outcome.status !== "ok" || this.#disposed) return outcome;
    const product = outcome.value;
    const products = this.#snapshot.products;
    if (products.items.some((item) => item.id === product.id)) {
      this.#patch({
        products: {
          ...products,
          items:
            product.status === products.status
              ? products.items.map((item) => (item.id === product.id ? product : item))
              : products.items.filter((item) => item.id !== product.id),
        },
      });
    }
    return outcome;
  }

  async #request<T>(
    scope: BusinessRequestPolicy["notFoundScope"],
    send: (api: TaliApiClient, credentials: BusinessRequestCredentials) => Promise<ApiResult<T>>,
  ): Promise<CatalogOutcome<T>> {
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

  #patch(changes: Partial<CatalogSnapshot>): void {
    if (this.#disposed) return;
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...changes });
    for (const listener of this.#listeners) listener();
  }
}
