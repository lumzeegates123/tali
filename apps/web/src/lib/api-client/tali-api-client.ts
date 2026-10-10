import type {
  AcceptInvitationResponse,
  AddPackRequest,
  ArchiveCategoryRequest,
  ArchiveProductRequest,
  BusinessCurrencyResponse,
  BusinessResponse,
  CategoriesResponse,
  CategoryListParams,
  CategoryResponse,
  CreateBusinessRequest,
  CreateBusinessResponse,
  CreateCategoryRequest,
  CreateInvitationRequest,
  CreateInvitationResponse,
  CreateProductRequest,
  CurrentUserResponse,
  LocalSignInResponse,
  LocationsResponse,
  MembersResponse,
  MyBusinessesResponse,
  PackListParams,
  PackResponse,
  PacksResponse,
  PriceHistoryResponse,
  ProductListParams,
  ProductResponse,
  ProductsResponse,
  ReactivateProductRequest,
  ReadinessResponse,
  RevokeInvitationResponse,
  SetSellingPriceRequest,
  UnitsResponse,
  UpdateCategoryRequest,
  UpdateProductRequest,
} from "@tali/shared";
import type {
  AdjustmentResponse,
  AdjustmentReversalResponse,
  CancelStocktakeRequest,
  CancelStocktakeResponse,
  ClearLowStockThresholdRequest,
  CreateStocktakeRequest,
  GoodsReceiptResponse,
  GoodsReceiptReversalResponse,
  InventoryItemListParams,
  InventoryItemResponse,
  InventoryItemsResponse,
  InventoryMovementsResponse,
  LowStockThresholdResponse,
  OpeningBatchResponse,
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
  StocktakeLinesResponse,
  StocktakeListParams,
  StocktakeResponse,
  StocktakesResponse,
  StocktakeStaleDetails,
} from "@tali/shared";
import {
  AdjustmentResponseSchema,
  AdjustmentReversalResponseSchema,
  CancelStocktakeResponseSchema,
  GoodsReceiptResponseSchema,
  GoodsReceiptReversalResponseSchema,
  InventoryItemResponseSchema,
  InventoryItemsResponseSchema,
  InventoryMovementsResponseSchema,
  LowStockThresholdResponseSchema,
  OpeningBatchResponseSchema,
  PostStocktakeResponseSchema,
  StocktakeCreationResponseSchema,
  StocktakeLineChangeResponseSchema,
  StocktakeLinesResponseSchema,
  StocktakeResponseSchema,
  StocktakesResponseSchema,
  StocktakeStaleErrorEnvelopeSchema,
} from "@tali/shared";
import {
  AcceptInvitationResponseSchema,
  BusinessCurrencyResponseSchema,
  BusinessResponseSchema,
  CategoriesResponseSchema,
  CategoryResponseSchema,
  PackResponseSchema,
  PacksResponseSchema,
  PriceHistoryResponseSchema,
  ProductResponseSchema,
  ProductsResponseSchema,
  UnitsResponseSchema,
  CreateInvitationResponseSchema,
  RevokeInvitationResponseSchema,
  CreateBusinessResponseSchema,
  CurrentUserResponseSchema,
  ErrorEnvelopeSchema,
  LocalSignInResponseSchema,
  LocationsResponseSchema,
  MembersResponseSchema,
  MyBusinessesResponseSchema,
  ReadinessResponseSchema,
} from "@tali/shared";

export const CORRELATION_HEADER = "x-correlation-id";
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const DEFAULT_TIMEOUT_MS = 5_000;
/** Mutations get longer: a timed-out mutation has an unknown outcome and must be retried with the same key. */
const MUTATION_TIMEOUT_MS = 15_000;
const MAX_FIELD_NAMES = 20;

/** Why a call to the Tali API did not produce a contract response. */
export type ApiFailure =
  | { readonly kind: "unavailable"; readonly reason: "network" | "timeout" }
  | {
      readonly kind: "api-error";
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly correlationId: string | undefined;
      /** Request fields named by a VALIDATION_FAILED response (last path segment only). */
      readonly fields: readonly string[];
      /** The strict details of a STOCKTAKE_STALE response; absent for every other code. */
      readonly stale?: StocktakeStaleDetails;
    }
  | { readonly kind: "invalid-response"; readonly status: number; readonly correlationId: string | undefined };

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly value: T; readonly correlationId: string | undefined }
  | { readonly ok: false; readonly failure: ApiFailure };

export interface TaliApiClientOptions {
  /** From public configuration (NEXT_PUBLIC_API_BASE_URL); never a server URL or secret. */
  readonly baseUrl: string;
  readonly createCorrelationId: () => string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** The bearer access token, held only by the in-memory session. */
export type AccessToken = string & { readonly __brand: "AccessToken" };

export type InvitableRole = CreateInvitationRequest["role"];

export interface PageRequest {
  readonly limit?: number;
  readonly after?: string;
}

interface Exchange {
  readonly status: number;
  readonly body: unknown;
  readonly correlationId: string | undefined;
}

interface RequestSpec {
  readonly method: "GET" | "POST" | "PATCH" | "PUT";
  readonly path: string;
  readonly token?: AccessToken;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

interface ResponseSchema<T> {
  safeParse(value: unknown): { readonly success: true; readonly data: T } | { readonly success: false };
}

/**
 * The web client's boundary to the Tali API. Responses are validated against
 * the shared wire contracts (@tali/shared); errors are mapped from the
 * standard error envelope. The API is authoritative: this client only
 * transports requests, attaching `Authorization` when the caller passes a
 * token and never logging or storing it.
 */
export class TaliApiClient {
  readonly #baseUrl: string;
  readonly #createCorrelationId: () => string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: TaliApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#createCorrelationId = options.createCorrelationId;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** `GET /health/ready`: 200 (ready) and 503 (not ready) are both contract responses. */
  async getReadiness(): Promise<ApiResult<ReadinessResponse>> {
    const exchange = await this.#send({ method: "GET", path: "/health/ready" });
    if (!("status" in exchange)) return exchange;
    return interpret(exchange, [200, 503], ReadinessResponseSchema);
  }

  /** `POST /__local/sign-in`: local development only; the route does not exist in any other environment. */
  async localSignIn(subject: string): Promise<ApiResult<LocalSignInResponse>> {
    return this.#call(
      { method: "POST", path: "/__local/sign-in", body: { subject } },
      [200],
      LocalSignInResponseSchema,
    );
  }

  async getCurrentUser(token: AccessToken): Promise<ApiResult<CurrentUserResponse>> {
    return this.#call({ method: "GET", path: "/v1/me", token }, [200], CurrentUserResponseSchema);
  }

  /** 201 for a new registration, 200 when the identity is already registered. */
  async registerCurrentUser(token: AccessToken, displayName: string): Promise<ApiResult<CurrentUserResponse>> {
    return this.#call(
      { method: "POST", path: "/v1/me/registration", token, body: { displayName } },
      [200, 201],
      CurrentUserResponseSchema,
    );
  }

  async listMyBusinesses(token: AccessToken, page: PageRequest = {}): Promise<ApiResult<MyBusinessesResponse>> {
    return this.#call(
      { method: "GET", path: `/v1/me/businesses${pageQuery(page)}`, token },
      [200],
      MyBusinessesResponseSchema,
    );
  }

  /** Requires an RFC 9562 UUID idempotency key; one logical submission keeps one key across retries. */
  async createBusiness(
    token: AccessToken,
    command: CreateBusinessRequest,
    idempotencyKey: string,
  ): Promise<ApiResult<CreateBusinessResponse>> {
    return this.#call(
      {
        method: "POST",
        path: "/v1/businesses",
        token,
        body: command,
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      },
      [201],
      CreateBusinessResponseSchema,
    );
  }

  async getBusiness(token: AccessToken, businessId: string): Promise<ApiResult<BusinessResponse>> {
    return this.#call({ method: "GET", path: businessPath(businessId), token }, [200], BusinessResponseSchema);
  }

  async listLocations(
    token: AccessToken,
    businessId: string,
    page: PageRequest = {},
  ): Promise<ApiResult<LocationsResponse>> {
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/locations${pageQuery(page)}`, token },
      [200],
      LocationsResponseSchema,
    );
  }

  async listMembers(
    token: AccessToken,
    businessId: string,
    page: PageRequest = {},
  ): Promise<ApiResult<MembersResponse>> {
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/members${pageQuery(page)}`, token },
      [200],
      MembersResponseSchema,
    );
  }

  /**
   * `POST .../invitations` (`member:invite`). The token is only in the first
   * 201 response; a replay answers `tokenAvailable: false`.
   */
  async createInvitation(
    token: AccessToken,
    businessId: string,
    role: InvitableRole,
    idempotencyKey: string,
  ): Promise<ApiResult<CreateInvitationResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/invitations`,
        token,
        body: { role },
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      },
      [201],
      CreateInvitationResponseSchema,
    );
  }

  async revokeInvitation(
    token: AccessToken,
    businessId: string,
    invitationId: string,
  ): Promise<ApiResult<RevokeInvitationResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/invitations/${encodeURIComponent(invitationId)}/revoke`,
        token,
        body: {},
      },
      [200],
      RevokeInvitationResponseSchema,
    );
  }

  /** `POST /v1/invitations/accept`: the invitation token travels in the body only, never in a URL. */
  async acceptInvitation(token: AccessToken, invitationToken: string): Promise<ApiResult<AcceptInvitationResponse>> {
    return this.#call(
      { method: "POST", path: "/v1/invitations/accept", token, body: { token: invitationToken } },
      [200],
      AcceptInvitationResponseSchema,
    );
  }

  /** `GET .../currency` (`business:read`): the code and minor-unit digits used to parse and format money. */
  async getBusinessCurrency(token: AccessToken, businessId: string): Promise<ApiResult<BusinessCurrencyResponse>> {
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/currency`, token },
      [200],
      BusinessCurrencyResponseSchema,
    );
  }

  async listUnits(token: AccessToken, businessId: string): Promise<ApiResult<UnitsResponse>> {
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/catalog/units`, token },
      [200],
      UnitsResponseSchema,
    );
  }

  async listProducts(
    token: AccessToken,
    businessId: string,
    params: ProductListParams = {},
  ): Promise<ApiResult<ProductsResponse>> {
    const query = searchQuery({ limit: params.limit, after: params.after, status: params.status, q: params.q });
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/products${query}`, token },
      [200],
      ProductsResponseSchema,
    );
  }

  async getProduct(token: AccessToken, businessId: string, productId: string): Promise<ApiResult<ProductResponse>> {
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/products/${segment(productId)}`, token },
      [200],
      ProductResponseSchema,
    );
  }

  /** `product:manage` (and `product:price` with `initialPrice`); one logical submission keeps one key. */
  async createProduct(
    token: AccessToken,
    businessId: string,
    command: CreateProductRequest,
    idempotencyKey: string,
  ): Promise<ApiResult<ProductResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/products`,
        token,
        body: command,
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      },
      [201],
      ProductResponseSchema,
    );
  }

  async updateProduct(
    token: AccessToken,
    businessId: string,
    productId: string,
    command: UpdateProductRequest,
  ): Promise<ApiResult<ProductResponse>> {
    return this.#call(
      { method: "PATCH", path: `${businessPath(businessId)}/products/${segment(productId)}`, token, body: command },
      [200],
      ProductResponseSchema,
    );
  }

  async archiveProduct(
    token: AccessToken,
    businessId: string,
    productId: string,
    command: ArchiveProductRequest,
  ): Promise<ApiResult<ProductResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/products/${segment(productId)}/archive`,
        token,
        body: command,
      },
      [200],
      ProductResponseSchema,
    );
  }

  async reactivateProduct(
    token: AccessToken,
    businessId: string,
    productId: string,
    command: ReactivateProductRequest,
  ): Promise<ApiResult<ProductResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/products/${segment(productId)}/reactivate`,
        token,
        body: command,
      },
      [200],
      ProductResponseSchema,
    );
  }

  /** `PUT .../price` (`product:price`): the amount is an exact minor-unit string in the business currency. */
  async setSellingPrice(
    token: AccessToken,
    businessId: string,
    productId: string,
    command: SetSellingPriceRequest,
  ): Promise<ApiResult<ProductResponse>> {
    return this.#call(
      {
        method: "PUT",
        path: `${businessPath(businessId)}/products/${segment(productId)}/price`,
        token,
        body: command,
      },
      [200],
      ProductResponseSchema,
    );
  }

  async listPriceHistory(
    token: AccessToken,
    businessId: string,
    productId: string,
    page: PageRequest = {},
  ): Promise<ApiResult<PriceHistoryResponse>> {
    return this.#call(
      {
        method: "GET",
        path: `${businessPath(businessId)}/products/${segment(productId)}/prices${pageQuery(page)}`,
        token,
      },
      [200],
      PriceHistoryResponseSchema,
    );
  }

  async listCategories(
    token: AccessToken,
    businessId: string,
    params: CategoryListParams = {},
  ): Promise<ApiResult<CategoriesResponse>> {
    const query = searchQuery({ limit: params.limit, after: params.after, status: params.status });
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/categories${query}`, token },
      [200],
      CategoriesResponseSchema,
    );
  }

  async getCategory(token: AccessToken, businessId: string, categoryId: string): Promise<ApiResult<CategoryResponse>> {
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/categories/${segment(categoryId)}`, token },
      [200],
      CategoryResponseSchema,
    );
  }

  async createCategory(
    token: AccessToken,
    businessId: string,
    command: CreateCategoryRequest,
    idempotencyKey: string,
  ): Promise<ApiResult<CategoryResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/categories`,
        token,
        body: command,
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      },
      [201],
      CategoryResponseSchema,
    );
  }

  async updateCategory(
    token: AccessToken,
    businessId: string,
    categoryId: string,
    command: UpdateCategoryRequest,
  ): Promise<ApiResult<CategoryResponse>> {
    return this.#call(
      { method: "PATCH", path: `${businessPath(businessId)}/categories/${segment(categoryId)}`, token, body: command },
      [200],
      CategoryResponseSchema,
    );
  }

  async archiveCategory(
    token: AccessToken,
    businessId: string,
    categoryId: string,
    command: ArchiveCategoryRequest,
  ): Promise<ApiResult<CategoryResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/categories/${segment(categoryId)}/archive`,
        token,
        body: command,
      },
      [200],
      CategoryResponseSchema,
    );
  }

  async listPacks(
    token: AccessToken,
    businessId: string,
    productId: string,
    params: PackListParams = {},
  ): Promise<ApiResult<PacksResponse>> {
    const query = searchQuery({ limit: params.limit, after: params.after, status: params.status });
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/products/${segment(productId)}/packs${query}`, token },
      [200],
      PacksResponseSchema,
    );
  }

  async addPack(
    token: AccessToken,
    businessId: string,
    productId: string,
    command: AddPackRequest,
    idempotencyKey: string,
  ): Promise<ApiResult<PackResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/products/${segment(productId)}/packs`,
        token,
        body: command,
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      },
      [201],
      PackResponseSchema,
    );
  }

  async retirePack(token: AccessToken, businessId: string, packId: string): Promise<ApiResult<PackResponse>> {
    return this.#call(
      { method: "POST", path: `${businessPath(businessId)}/packs/${segment(packId)}/retire`, token, body: {} },
      [200],
      PackResponseSchema,
    );
  }

  // ---- Inventory (Slice 6 routes; the location is the business default, resolved server-side) ----

  /** `GET .../inventory/balances` (`inventory:read`): `lowStock` and the LOW STOCK flag are computed by the API. */
  async listInventoryItems(
    token: AccessToken,
    businessId: string,
    params: InventoryItemListParams = {},
  ): Promise<ApiResult<InventoryItemsResponse>> {
    const query = searchQuery({
      limit: params.limit,
      after: params.after,
      q: params.q,
      lowStock: params.lowStock === true ? "true" : undefined,
    });
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/inventory/balances${query}`, token },
      [200],
      InventoryItemsResponseSchema,
    );
  }

  async getInventoryItem(
    token: AccessToken,
    businessId: string,
    variantId: string,
  ): Promise<ApiResult<InventoryItemResponse>> {
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/inventory/items/${segment(variantId)}`, token },
      [200],
      InventoryItemResponseSchema,
    );
  }

  /** Newest first. */
  async listInventoryMovements(
    token: AccessToken,
    businessId: string,
    variantId: string,
    page: PageRequest = {},
  ): Promise<ApiResult<InventoryMovementsResponse>> {
    return this.#call(
      {
        method: "GET",
        path: `${businessPath(businessId)}/inventory/items/${segment(variantId)}/movements${pageQuery(page)}`,
        token,
      },
      [200],
      InventoryMovementsResponseSchema,
    );
  }

  /** `inventory:opening`; keyed: one logical submission keeps one key across uncertain retries. */
  async recordOpeningStock(
    token: AccessToken,
    businessId: string,
    command: RecordOpeningStockRequest,
    idempotencyKey: string,
  ): Promise<ApiResult<OpeningBatchResponse>> {
    return this.#keyedInventoryPost(
      token,
      businessId,
      "opening-stock",
      command,
      idempotencyKey,
      OpeningBatchResponseSchema,
    );
  }

  async getOpeningBatch(
    token: AccessToken,
    businessId: string,
    openingBatchId: string,
  ): Promise<ApiResult<OpeningBatchResponse>> {
    return this.#call(
      {
        method: "GET",
        path: `${businessPath(businessId)}/inventory/opening-batches/${segment(openingBatchId)}`,
        token,
      },
      [200],
      OpeningBatchResponseSchema,
    );
  }

  /** `inventory:receive`; keyed. Reference and note only: no supplier, cost or tax. */
  async postGoodsReceipt(
    token: AccessToken,
    businessId: string,
    command: PostGoodsReceiptRequest,
    idempotencyKey: string,
  ): Promise<ApiResult<GoodsReceiptResponse>> {
    return this.#keyedInventoryPost(
      token,
      businessId,
      "goods-receipts",
      command,
      idempotencyKey,
      GoodsReceiptResponseSchema,
    );
  }

  async getGoodsReceipt(
    token: AccessToken,
    businessId: string,
    goodsReceiptId: string,
  ): Promise<ApiResult<GoodsReceiptResponse>> {
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/inventory/goods-receipts/${segment(goodsReceiptId)}`, token },
      [200],
      GoodsReceiptResponseSchema,
    );
  }

  /** `inventory:adjust`; state-setting: a repeat answers `changed: false`. */
  async reverseGoodsReceipt(
    token: AccessToken,
    businessId: string,
    goodsReceiptId: string,
    command: ReverseDocumentRequest,
  ): Promise<ApiResult<GoodsReceiptReversalResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/inventory/goods-receipts/${segment(goodsReceiptId)}/reverse`,
        token,
        body: command,
      },
      [200],
      GoodsReceiptReversalResponseSchema,
    );
  }

  /** `inventory:adjust`; keyed. */
  async recordAdjustment(
    token: AccessToken,
    businessId: string,
    command: RecordAdjustmentRequest,
    idempotencyKey: string,
  ): Promise<ApiResult<AdjustmentResponse>> {
    return this.#keyedInventoryPost(
      token,
      businessId,
      "adjustments",
      command,
      idempotencyKey,
      AdjustmentResponseSchema,
    );
  }

  /** `inventory:adjust`; keyed. Lines are positive magnitudes; the API records them as decreases. */
  async recordWriteOff(
    token: AccessToken,
    businessId: string,
    command: RecordWriteOffRequest,
    idempotencyKey: string,
  ): Promise<ApiResult<AdjustmentResponse>> {
    return this.#keyedInventoryPost(token, businessId, "write-offs", command, idempotencyKey, AdjustmentResponseSchema);
  }

  async getAdjustment(
    token: AccessToken,
    businessId: string,
    adjustmentId: string,
  ): Promise<ApiResult<AdjustmentResponse>> {
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/inventory/adjustments/${segment(adjustmentId)}`, token },
      [200],
      AdjustmentResponseSchema,
    );
  }

  /** `inventory:adjust`; reverses an adjustment or a write-off. */
  async reverseAdjustment(
    token: AccessToken,
    businessId: string,
    adjustmentId: string,
    command: ReverseDocumentRequest,
  ): Promise<ApiResult<AdjustmentReversalResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/inventory/adjustments/${segment(adjustmentId)}/reverse`,
        token,
        body: command,
      },
      [200],
      AdjustmentReversalResponseSchema,
    );
  }

  /** `PUT .../threshold` (`inventory:threshold`): `expectedVersion` 0 sets the first threshold. */
  async setLowStockThreshold(
    token: AccessToken,
    businessId: string,
    variantId: string,
    command: SetLowStockThresholdRequest,
  ): Promise<ApiResult<LowStockThresholdResponse>> {
    return this.#call(
      {
        method: "PUT",
        path: `${businessPath(businessId)}/inventory/items/${segment(variantId)}/threshold`,
        token,
        body: command,
      },
      [200],
      LowStockThresholdResponseSchema,
    );
  }

  async clearLowStockThreshold(
    token: AccessToken,
    businessId: string,
    variantId: string,
    command: ClearLowStockThresholdRequest,
  ): Promise<ApiResult<LowStockThresholdResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/inventory/items/${segment(variantId)}/threshold/clear`,
        token,
        body: command,
      },
      [200],
      LowStockThresholdResponseSchema,
    );
  }

  /** `inventory:count`; keyed. One DRAFT per location: a second create answers CONFLICT. */
  async createStocktake(
    token: AccessToken,
    businessId: string,
    command: CreateStocktakeRequest,
    idempotencyKey: string,
  ): Promise<ApiResult<StocktakeCreationResponse>> {
    return this.#keyedInventoryPost(
      token,
      businessId,
      "stocktakes",
      command,
      idempotencyKey,
      StocktakeCreationResponseSchema,
    );
  }

  async listStocktakes(
    token: AccessToken,
    businessId: string,
    params: StocktakeListParams = {},
  ): Promise<ApiResult<StocktakesResponse>> {
    const query = searchQuery({ limit: params.limit, after: params.after, status: params.status });
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/inventory/stocktakes${query}`, token },
      [200],
      StocktakesResponseSchema,
    );
  }

  /** FULL or BLIND, decided by the API from the caller's permissions. */
  async getStocktake(
    token: AccessToken,
    businessId: string,
    stocktakeId: string,
  ): Promise<ApiResult<StocktakeResponse>> {
    return this.#call(
      { method: "GET", path: `${businessPath(businessId)}/inventory/stocktakes/${segment(stocktakeId)}`, token },
      [200],
      StocktakeResponseSchema,
    );
  }

  /** Variant-ID order, REMOVED lines included. */
  async listStocktakeLines(
    token: AccessToken,
    businessId: string,
    stocktakeId: string,
    page: PageRequest = {},
  ): Promise<ApiResult<StocktakeLinesResponse>> {
    return this.#call(
      {
        method: "GET",
        path: `${businessPath(businessId)}/inventory/stocktakes/${segment(stocktakeId)}/lines${pageQuery(page)}`,
        token,
      },
      [200],
      StocktakeLinesResponseSchema,
    );
  }

  /** `PUT .../lines/:variantId` (`inventory:count`): omit `expectedVersion` for a first count, else the line version. */
  async recordStocktakeCount(
    token: AccessToken,
    businessId: string,
    stocktakeId: string,
    variantId: string,
    command: RecordStocktakeCountRequest,
  ): Promise<ApiResult<StocktakeLineChangeResponse>> {
    return this.#call(
      {
        method: "PUT",
        path: `${businessPath(businessId)}/inventory/stocktakes/${segment(stocktakeId)}/lines/${segment(variantId)}`,
        token,
        body: command,
      },
      [200],
      StocktakeLineChangeResponseSchema,
    );
  }

  async removeStocktakeLine(
    token: AccessToken,
    businessId: string,
    stocktakeId: string,
    variantId: string,
    command: RemoveStocktakeLineRequest,
  ): Promise<ApiResult<StocktakeLineChangeResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/inventory/stocktakes/${segment(stocktakeId)}/lines/${segment(variantId)}/remove`,
        token,
        body: command,
      },
      [200],
      StocktakeLineChangeResponseSchema,
    );
  }

  /** `inventory:count-post`: posting a POSTED stocktake answers the posted result (`changed: false`). */
  async postStocktake(
    token: AccessToken,
    businessId: string,
    stocktakeId: string,
    command: PostStocktakeRequest,
  ): Promise<ApiResult<PostStocktakeResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/inventory/stocktakes/${segment(stocktakeId)}/post`,
        token,
        body: command,
      },
      [200],
      PostStocktakeResponseSchema,
    );
  }

  async cancelStocktake(
    token: AccessToken,
    businessId: string,
    stocktakeId: string,
    command: CancelStocktakeRequest,
  ): Promise<ApiResult<CancelStocktakeResponse>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/inventory/stocktakes/${segment(stocktakeId)}/cancel`,
        token,
        body: command,
      },
      [200],
      CancelStocktakeResponseSchema,
    );
  }

  async #keyedInventoryPost<T>(
    token: AccessToken,
    businessId: string,
    route: "opening-stock" | "goods-receipts" | "adjustments" | "write-offs" | "stocktakes",
    command: unknown,
    idempotencyKey: string,
    schema: ResponseSchema<T>,
  ): Promise<ApiResult<T>> {
    return this.#call(
      {
        method: "POST",
        path: `${businessPath(businessId)}/inventory/${route}`,
        token,
        body: command,
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      },
      [201],
      schema,
    );
  }

  async #call<T>(spec: RequestSpec, statuses: readonly number[], schema: ResponseSchema<T>): Promise<ApiResult<T>> {
    const exchange = await this.#send(spec);
    if (!("status" in exchange)) return exchange;
    return interpret(exchange, statuses, schema);
  }

  async #send(spec: RequestSpec): Promise<Exchange | { readonly ok: false; readonly failure: ApiFailure }> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        controller.abort();
      },
      spec.method === "GET" ? this.#timeoutMs : Math.max(this.#timeoutMs, MUTATION_TIMEOUT_MS),
    );
    const headers: Record<string, string> = {
      accept: "application/json",
      [CORRELATION_HEADER]: this.#createCorrelationId(),
      ...spec.headers,
    };
    if (spec.token !== undefined) headers["authorization"] = `Bearer ${spec.token}`;
    if (spec.body !== undefined) headers["content-type"] = "application/json";
    try {
      const response = await this.#fetch(`${this.#baseUrl}${spec.path}`, {
        method: spec.method,
        headers,
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
      });
      const correlationId = response.headers.get(CORRELATION_HEADER) ?? undefined;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      return { status: response.status, body, correlationId };
    } catch {
      return { ok: false, failure: { kind: "unavailable", reason: controller.signal.aborted ? "timeout" : "network" } };
    } finally {
      clearTimeout(timer);
    }
  }
}

function businessPath(businessId: string): string {
  return `/v1/businesses/${encodeURIComponent(businessId)}`;
}

function pageQuery(page: PageRequest): string {
  return searchQuery({ limit: page.limit, after: page.after });
}

/** Encodes defined query values only; an absent value is never sent as an empty parameter. */
function searchQuery(values: Readonly<Record<string, string | number | undefined>>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) params.set(name, String(value));
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

function segment(id: string): string {
  return encodeURIComponent(id);
}

function interpret<T>(exchange: Exchange, statuses: readonly number[], schema: ResponseSchema<T>): ApiResult<T> {
  if (statuses.includes(exchange.status)) {
    const parsed = schema.safeParse(exchange.body);
    if (parsed.success) {
      return { ok: true, status: exchange.status, value: parsed.data, correlationId: exchange.correlationId };
    }
    return {
      ok: false,
      failure: { kind: "invalid-response", status: exchange.status, correlationId: exchange.correlationId },
    };
  }
  return { ok: false, failure: toFailure(exchange) };
}

function toFailure(exchange: Exchange): ApiFailure {
  const envelope = ErrorEnvelopeSchema.safeParse(exchange.body);
  if (envelope.success) {
    const stale =
      envelope.data.error.code === "STOCKTAKE_STALE"
        ? StocktakeStaleErrorEnvelopeSchema.safeParse(exchange.body)
        : undefined;
    return {
      kind: "api-error",
      status: exchange.status,
      code: envelope.data.error.code,
      message: envelope.data.error.message,
      correlationId: exchange.correlationId,
      fields: fieldNames(envelope.data.error.details),
      ...(stale?.success === true ? { stale: stale.data.error.details } : {}),
    };
  }
  return { kind: "invalid-response", status: exchange.status, correlationId: exchange.correlationId };
}

/** Field names from validation issue paths (`[{ path: ["body", "name"], ... }]`); nothing else is kept. */
function fieldNames(details: unknown): readonly string[] {
  if (!Array.isArray(details)) return [];
  const names = new Set<string>();
  for (const issue of details.slice(0, MAX_FIELD_NAMES)) {
    const path: unknown = typeof issue === "object" && issue !== null ? (issue as { path?: unknown }).path : undefined;
    if (!Array.isArray(path)) continue;
    const last: unknown = path.at(-1);
    if (typeof last === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(last)) names.add(last);
  }
  return [...names];
}
