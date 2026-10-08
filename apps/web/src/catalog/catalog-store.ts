import type { CurrencyDefinition } from "@tali/domain/kernel";
import type {
  AddPackRequest,
  ArchiveCategoryRequest,
  ArchiveProductRequest,
  CategoryResponse,
  CreateCategoryRequest,
  CreateProductRequest,
  PackResponse,
  PacksResponse,
  PriceHistoryResponse,
  ProductResponse,
  ReactivateProductRequest,
  SetSellingPriceRequest,
  UnitResponse,
  UpdateCategoryRequest,
  UpdateProductRequest,
} from "@tali/shared";
import type { ApiFailure, ApiResult, TaliApiClient } from "../lib/api-client/tali-api-client";
import type {
  BusinessRequestCredentials,
  BusinessRequestPolicy,
  BusinessRequestResult,
} from "../lib/auth/session-store";
import {
  type AddPackCommand,
  KeyedSubmission,
  sameAddPack,
  sameCreateCategory,
  sameCreateProduct,
} from "./keyed-submission";
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

interface PagedList<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly phase: LoadPhase;
  readonly failure: ApiFailure | undefined;
  readonly loadingMore: boolean;
  /** A failed Show more keeps the loaded items; retrying uses the same cursor. */
  readonly moreFailure: ApiFailure | undefined;
}

export interface ProductListState extends PagedList<ProductResponse> {
  /** The search term as sent (trimmed); empty means no `q`. */
  readonly query: string;
  readonly status: CatalogStatus;
}

export interface CategoryListState extends PagedList<CategoryResponse> {
  readonly status: CatalogStatus;
}

export interface ReferenceState {
  readonly phase: LoadPhase;
  readonly currency: CurrencyDefinition | undefined;
  readonly units: readonly UnitResponse[];
  readonly failure: ApiFailure | undefined;
}

export interface CategoryOptionsState {
  readonly phase: LoadPhase;
  /** ACTIVE categories for the product form, in API order. */
  readonly items: readonly CategoryResponse[];
  /** Not every category could be listed (page cap, repeated cursor, empty page or a failed page). */
  readonly truncated: boolean;
  readonly failure: ApiFailure | undefined;
}

/** Everything catalog components may render. It never holds a token, device credential or idempotency key. */
export interface CatalogSnapshot {
  /** A business-level read answered NOT_FOUND; only the user's Switch business changes the selection. */
  readonly businessUnavailable: boolean;
  readonly reference: ReferenceState;
  readonly products: ProductListState;
  readonly categoryOptions: CategoryOptionsState;
  readonly categories: CategoryListState;
  readonly submitting: {
    readonly createProduct: boolean;
    readonly createCategory: boolean;
    readonly addPack: boolean;
  };
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

function appendUnique<T extends { readonly id: string }>(existing: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(existing.map((item) => item.id));
  return [...existing, ...page.filter((item) => !seen.has(item.id))];
}

function isApiError(failure: ApiFailure, code: string): boolean {
  return failure.kind === "api-error" && failure.code === code;
}

/**
 * Catalog state for one selected business (plan 004 Slice 4), in memory only.
 * Created when the business workspace mounts and disposed when it unmounts,
 * so a business switch or sign-out drops everything. Every request goes
 * through `CatalogSession.businessRequest`, which supplies credentials for
 * that one request; this store never keeps them. List generations make a
 * newer search supersede late pages from an older one. The API stays
 * authoritative for permissions, tenancy, validation and idempotency.
 */
export class CatalogStore {
  readonly #businessId: string;
  readonly #session: CatalogSession;
  readonly #listeners = new Set<() => void>();
  readonly #createProduct: KeyedSubmission<CreateProductRequest>;
  readonly #createCategory: KeyedSubmission<CreateCategoryRequest>;
  readonly #addPack: KeyedSubmission<AddPackCommand>;
  #snapshot: CatalogSnapshot;
  #disposed = false;
  #productGeneration = 0;
  #categoryGeneration = 0;
  #optionsGeneration = 0;
  #referenceGeneration = 0;

  constructor(options: CatalogStoreOptions) {
    this.#businessId = options.businessId;
    this.#session = options.session;
    this.#createProduct = new KeyedSubmission(sameCreateProduct, options.newIdempotencyKey);
    this.#createCategory = new KeyedSubmission(sameCreateCategory, options.newIdempotencyKey);
    this.#addPack = new KeyedSubmission(sameAddPack, options.newIdempotencyKey);
    this.#snapshot = Object.freeze<CatalogSnapshot>({
      businessUnavailable: false,
      reference: { phase: "loading", currency: undefined, units: [], failure: undefined },
      products: { ...emptyList<ProductResponse>(), query: "", status: "ACTIVE" },
      categoryOptions: { phase: "loading", items: [], truncated: false, failure: undefined },
      categories: { ...emptyList<CategoryResponse>(), status: "ACTIVE" },
      submitting: { createProduct: false, createCategory: false, addPack: false },
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): CatalogSnapshot => this.#snapshot;

  get businessId(): string {
    return this.#businessId;
  }

  /** Loads the reference data, the first ACTIVE product page and the category options. */
  start(): void {
    void this.loadReference();
    void this.searchProducts("", "ACTIVE");
    void this.loadCategoryOptions();
  }

  /** Ignores every later result and forgets all idempotency attempts. */
  dispose(): void {
    this.#disposed = true;
    this.#createProduct.reset();
    this.#createCategory.reset();
    this.#addPack.reset();
    this.#listeners.clear();
  }

  // ---- Reference data (business scope) -----------------------------------

  /** `GET .../currency` and `GET .../catalog/units`, once per business (and on retry). */
  async loadReference(): Promise<void> {
    const generation = ++this.#referenceGeneration;
    this.#patch({ reference: { ...this.#snapshot.reference, phase: "loading", failure: undefined } });
    const [currency, units] = await Promise.all([
      this.#request("business", (api, { token }) => api.getBusinessCurrency(token, this.#businessId)),
      this.#request("business", (api, { token }) => api.listUnits(token, this.#businessId)),
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

  // ---- Product list (business scope) -------------------------------------

  /** A new search or status: the cursor resets and the results are replaced. `q` is sent only when not blank. */
  async searchProducts(query: string, status: CatalogStatus): Promise<void> {
    const q = query.trim();
    const generation = ++this.#productGeneration;
    this.#patch({ products: { ...emptyList<ProductResponse>(), query: q, status } });
    const outcome = await this.#request("business", (api, { token }) =>
      api.listProducts(token, this.#businessId, { status, ...(q === "" ? {} : { q }) }),
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

  /** Reloads the first page of the current search. */
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
    const outcome = await this.#request("business", (api, { token }) =>
      api.listProducts(token, this.#businessId, { status, after: nextCursor, ...(query === "" ? {} : { q: query }) }),
    );
    if (generation !== this.#productGeneration || this.#disposed) return;
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

  // ---- Products (resource scope) -----------------------------------------

  getProduct(productId: string): Promise<CatalogOutcome<ProductResponse>> {
    return this.#request("resource", (api, { token }) => api.getProduct(token, this.#businessId, productId));
  }

  /** Keyed create: retrying the unchanged command after an unknown outcome reuses its key. */
  async createProduct(command: CreateProductRequest): Promise<CatalogOutcome<ProductResponse>> {
    const outcome = await this.#keyed(this.#createProduct, "createProduct", command, (api, token, key) =>
      api.createProduct(token, this.#businessId, command, key),
    );
    if (outcome.status === "ok") void this.refreshProducts();
    return outcome;
  }

  async updateProduct(productId: string, command: UpdateProductRequest): Promise<CatalogOutcome<ProductResponse>> {
    return this.#productChange(
      await this.#request("resource", (api, { token }) =>
        api.updateProduct(token, this.#businessId, productId, command),
      ),
    );
  }

  async archiveProduct(productId: string, command: ArchiveProductRequest): Promise<CatalogOutcome<ProductResponse>> {
    return this.#productChange(
      await this.#request("resource", (api, { token }) =>
        api.archiveProduct(token, this.#businessId, productId, command),
      ),
    );
  }

  async reactivateProduct(
    productId: string,
    command: ReactivateProductRequest,
  ): Promise<CatalogOutcome<ProductResponse>> {
    return this.#productChange(
      await this.#request("resource", (api, { token }) =>
        api.reactivateProduct(token, this.#businessId, productId, command),
      ),
    );
  }

  async setSellingPrice(productId: string, command: SetSellingPriceRequest): Promise<CatalogOutcome<ProductResponse>> {
    return this.#productChange(
      await this.#request("resource", (api, { token }) =>
        api.setSellingPrice(token, this.#businessId, productId, command),
      ),
    );
  }

  listPriceHistory(productId: string, after?: string): Promise<CatalogOutcome<PriceHistoryResponse>> {
    return this.#request("resource", (api, { token }) =>
      api.listPriceHistory(token, this.#businessId, productId, after === undefined ? {} : { after }),
    );
  }

  // ---- Packs (resource scope) --------------------------------------------

  listPacks(productId: string, status: "ACTIVE" | "RETIRED", after?: string): Promise<CatalogOutcome<PacksResponse>> {
    return this.#request("resource", (api, { token }) =>
      api.listPacks(token, this.#businessId, productId, { status, ...(after === undefined ? {} : { after }) }),
    );
  }

  addPack(productId: string, request: AddPackRequest): Promise<CatalogOutcome<PackResponse>> {
    return this.#keyed(this.#addPack, "addPack", { productId, request }, (api, token, key) =>
      api.addPack(token, this.#businessId, productId, request, key),
    );
  }

  retirePack(packId: string): Promise<CatalogOutcome<PackResponse>> {
    return this.#request("resource", (api, { token }) => api.retirePack(token, this.#businessId, packId));
  }

  // ---- Categories --------------------------------------------------------

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
      const outcome = await this.#request("business", (api, { token }) =>
        api.listCategories(token, this.#businessId, {
          status: "ACTIVE",
          limit: CATEGORY_OPTION_PAGE_SIZE,
          ...(cursor === undefined ? {} : { after: cursor }),
        }),
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
    return this.#request("resource", (api, { token }) => api.getCategory(token, this.#businessId, categoryId));
  }

  /** The Categories panel list (web), ACTIVE or ARCHIVED. */
  async loadCategories(status: CatalogStatus): Promise<void> {
    const generation = ++this.#categoryGeneration;
    this.#patch({ categories: { ...emptyList<CategoryResponse>(), status } });
    const outcome = await this.#request("business", (api, { token }) =>
      api.listCategories(token, this.#businessId, { status }),
    );
    if (generation !== this.#categoryGeneration || outcome.status === "ignored") return;
    const categories = this.#snapshot.categories;
    this.#patch({
      categories:
        outcome.status === "failed"
          ? { ...categories, phase: "failed", failure: outcome.failure }
          : { ...categories, phase: "ready", items: outcome.value.items, nextCursor: outcome.value.nextCursor },
    });
  }

  async loadMoreCategories(): Promise<void> {
    const { nextCursor, status, phase, loadingMore } = this.#snapshot.categories;
    if (nextCursor === null || phase !== "ready" || loadingMore) return;
    const generation = this.#categoryGeneration;
    this.#patch({ categories: { ...this.#snapshot.categories, loadingMore: true, moreFailure: undefined } });
    const outcome = await this.#request("business", (api, { token }) =>
      api.listCategories(token, this.#businessId, { status, after: nextCursor }),
    );
    if (generation !== this.#categoryGeneration || this.#disposed) return;
    const categories = this.#snapshot.categories;
    if (outcome.status === "ignored") {
      this.#patch({ categories: { ...categories, loadingMore: false } });
      return;
    }
    this.#patch({
      categories:
        outcome.status === "failed"
          ? { ...categories, loadingMore: false, moreFailure: outcome.failure }
          : {
              ...categories,
              loadingMore: false,
              items: appendUnique(categories.items, outcome.value.items),
              nextCursor: outcome.value.nextCursor,
            },
    });
  }

  async createCategory(command: CreateCategoryRequest): Promise<CatalogOutcome<CategoryResponse>> {
    const outcome = await this.#keyed(this.#createCategory, "createCategory", command, (api, token, key) =>
      api.createCategory(token, this.#businessId, command, key),
    );
    if (outcome.status === "ok") this.#refreshCategories();
    return outcome;
  }

  async updateCategory(categoryId: string, command: UpdateCategoryRequest): Promise<CatalogOutcome<CategoryResponse>> {
    const outcome = await this.#request("resource", (api, { token }) =>
      api.updateCategory(token, this.#businessId, categoryId, command),
    );
    if (outcome.status === "ok") this.#refreshCategories();
    return outcome;
  }

  async archiveCategory(
    categoryId: string,
    command: ArchiveCategoryRequest,
  ): Promise<CatalogOutcome<CategoryResponse>> {
    const outcome = await this.#request("resource", (api, { token }) =>
      api.archiveCategory(token, this.#businessId, categoryId, command),
    );
    if (outcome.status === "ok") this.#refreshCategories();
    return outcome;
  }

  // ---- Internals ---------------------------------------------------------

  #refreshCategories(): void {
    void this.loadCategories(this.#snapshot.categories.status);
    void this.loadCategoryOptions();
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

  async #keyed<C, T>(
    submission: KeyedSubmission<C>,
    flag: keyof CatalogSnapshot["submitting"],
    command: C,
    send: (api: TaliApiClient, token: BusinessRequestCredentials["token"], key: string) => Promise<ApiResult<T>>,
  ): Promise<CatalogOutcome<T>> {
    if (this.#disposed) return IGNORED;
    const key = submission.begin(command);
    if (key === undefined) return IGNORED;
    this.#patch({ submitting: { ...this.#snapshot.submitting, [flag]: true } });
    let outcome: CatalogOutcome<T> = IGNORED;
    try {
      outcome = await this.#request("resource", (api, { token }) => send(api, token, key));
    } finally {
      submission.finish(
        outcome.status === "ok"
          ? "succeeded"
          : outcome.status === "failed" && isApiError(outcome.failure, "IDEMPOTENCY_KEY_REUSED")
            ? "keyReused"
            : "failed",
      );
      this.#patch({ submitting: { ...this.#snapshot.submitting, [flag]: false } });
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
