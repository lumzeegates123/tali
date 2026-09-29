import type { ReadinessResponse } from "@tali/shared";
import { ErrorEnvelopeSchema, ReadinessResponseSchema } from "@tali/shared";

export const CORRELATION_HEADER = "x-correlation-id";
const DEFAULT_TIMEOUT_MS = 5_000;

/** Why a call to the Tali API did not produce a contract response. */
export type ApiFailure =
  | { readonly kind: "unavailable"; readonly reason: "network" | "timeout" }
  | {
      readonly kind: "api-error";
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly correlationId: string | undefined;
    }
  | { readonly kind: "invalid-response"; readonly status: number; readonly correlationId: string | undefined };

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly value: T; readonly correlationId: string | undefined }
  | { readonly ok: false; readonly failure: ApiFailure };

export interface TaliApiClientOptions {
  /** From public configuration (EXPO_PUBLIC_API_BASE_URL); never a server URL or secret. */
  readonly baseUrl: string;
  readonly createCorrelationId: () => string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface Exchange {
  readonly status: number;
  readonly body: unknown;
  readonly correlationId: string | undefined;
}

/**
 * The mobile client's boundary to the Tali API. Responses are validated
 * against the shared wire contracts (@tali/shared); errors are mapped from the
 * standard error envelope. Presentation only: no business endpoints yet.
 * No `cache` option: React Native's fetch polyfill turns `no-store` into a
 * cache-busting query parameter.
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
    const exchange = await this.#get("/health/ready");
    if (!("status" in exchange)) return exchange;
    if (exchange.status === 200 || exchange.status === 503) {
      const parsed = ReadinessResponseSchema.safeParse(exchange.body);
      if (parsed.success) {
        return { ok: true, status: exchange.status, value: parsed.data, correlationId: exchange.correlationId };
      }
    }
    return { ok: false, failure: toFailure(exchange) };
  }

  async #get(path: string): Promise<Exchange | { readonly ok: false; readonly failure: ApiFailure }> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "GET",
        headers: { accept: "application/json", [CORRELATION_HEADER]: this.#createCorrelationId() },
        signal: controller.signal,
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

function toFailure(exchange: Exchange): ApiFailure {
  const envelope = ErrorEnvelopeSchema.safeParse(exchange.body);
  if (envelope.success) {
    return {
      kind: "api-error",
      status: exchange.status,
      code: envelope.data.error.code,
      message: envelope.data.error.message,
      correlationId: exchange.correlationId,
    };
  }
  return { kind: "invalid-response", status: exchange.status, correlationId: exchange.correlationId };
}
