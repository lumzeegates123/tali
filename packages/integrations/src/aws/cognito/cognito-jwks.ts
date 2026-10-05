import type { Clock } from "@tali/application";
import type { CryptoKey } from "jose";
import { importJWK } from "jose";

/** The only signing algorithm the Cognito adapter accepts (ADR-003 section 15). */
export const COGNITO_SIGNING_ALGORITHM = "RS256";

/** A fetch-shaped boundary, injectable so tests never reach the network. */
export type JwksFetch = (
  url: string,
  init: { readonly signal: AbortSignal; readonly redirect: "error" },
) => Promise<Response>;

export interface JwksCacheOptions {
  /** Built from trusted configuration only; never from a token. */
  readonly url: string;
  readonly clock: Clock;
  readonly fetch?: JwksFetch;
  /** Upper bound for one JWKS request. */
  readonly timeoutMs?: number;
  /** After a successful fetch, no further fetch happens for this long, however many unknown `kid`s arrive. */
  readonly minRefreshIntervalMs?: number;
  /** After a failed fetch, the next attempt waits this long. */
  readonly failureBackoffMs?: number;
}

export const JWKS_DEFAULTS = Object.freeze({
  timeoutMs: 3_000,
  minRefreshIntervalMs: 60_000,
  failureBackoffMs: 5_000,
  /** Cognito publishes two signing keys; a larger set is refused rather than cached. */
  maxKeys: 10,
  maxBodyBytes: 64 * 1024,
});

const KID = /^[A-Za-z0-9+/=_.-]{1,128}$/u;

export class JwksUnavailableError extends Error {
  constructor(reason: string) {
    super(`JWKS unavailable: ${reason}`);
    this.name = "JwksUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a JWKS into RS256 verification keys. Only the public RSA members
 * (`kty`, `n`, `e`) are imported. The whole document is refused when it is
 * not a key set, when any `kid` repeats, or when it is too large; individual
 * keys that are not RSA signing keys for RS256 are skipped. An empty result
 * is an error: the cache keeps its previous keys.
 */
export async function parseJwks(document: unknown): Promise<ReadonlyMap<string, CryptoKey>> {
  if (!isRecord(document) || !Array.isArray(document["keys"])) throw new JwksUnavailableError("malformed");
  const entries: unknown[] = document["keys"];
  if (entries.length > JWKS_DEFAULTS.maxKeys) throw new JwksUnavailableError("too many keys");
  const keys = new Map<string, CryptoKey>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) throw new JwksUnavailableError("malformed");
    const { kid, kty, n, e, alg, use } = entry;
    if (typeof kid !== "string" || !KID.test(kid)) continue;
    if (seen.has(kid)) throw new JwksUnavailableError("duplicate kid");
    seen.add(kid);
    if (kty !== "RSA" || typeof n !== "string" || typeof e !== "string") continue;
    if (alg !== undefined && alg !== COGNITO_SIGNING_ALGORITHM) continue;
    if (use !== undefined && use !== "sig") continue;
    try {
      const key = await importJWK({ kty, n, e }, COGNITO_SIGNING_ALGORITHM);
      if (key instanceof Uint8Array) continue;
      keys.set(kid, key);
    } catch {
      // A key jose cannot import as an RSA public key is unusable.
    }
  }
  if (keys.size === 0) throw new JwksUnavailableError("no usable keys");
  return keys;
}

/**
 * In-memory Cognito JWKS cache (ADR-003 section 15).
 *
 * - A known `kid` is served from memory with no network access.
 * - An unknown `kid` triggers a refresh, at most once per
 *   `minRefreshIntervalMs` after a success (60 s) or `failureBackoffMs` after
 *   a failure (5 s). Concurrent callers share one fetch. Within the window,
 *   unknown `kid`s are simply not found: a stream of forged key IDs cannot
 *   cause a fetch storm.
 * - The cache holds exactly the last successfully fetched key set (bounded by
 *   `maxKeys`); it never accumulates keys per requested `kid`.
 * - Fetches use the configured URL only, a timeout, no redirects, a body size
 *   limit, and fail closed: a failure leaves the previous keys in place and
 *   never produces a key.
 */
export class CognitoJwksCache {
  readonly #url: string;
  readonly #clock: Clock;
  readonly #fetch: JwksFetch;
  readonly #timeoutMs: number;
  readonly #minRefreshIntervalMs: number;
  readonly #failureBackoffMs: number;
  #keys: ReadonlyMap<string, CryptoKey> = new Map();
  #nextFetchAllowedAt = Number.NEGATIVE_INFINITY;
  #inFlight: Promise<void> | undefined;

  constructor(options: JwksCacheOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "https:") throw new Error("The JWKS URL must use https");
    this.#url = url.href;
    this.#clock = options.clock;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? JWKS_DEFAULTS.timeoutMs;
    this.#minRefreshIntervalMs = options.minRefreshIntervalMs ?? JWKS_DEFAULTS.minRefreshIntervalMs;
    this.#failureBackoffMs = options.failureBackoffMs ?? JWKS_DEFAULTS.failureBackoffMs;
  }

  /** The key for `kid`, refreshing once (rate-limited) when it is unknown; undefined fails verification. */
  async keyFor(kid: string): Promise<CryptoKey | undefined> {
    const known = this.#keys.get(kid);
    if (known !== undefined) return known;
    await this.#refreshIfAllowed();
    return this.#keys.get(kid);
  }

  /** Number of cached keys (for tests and diagnostics). */
  get size(): number {
    return this.#keys.size;
  }

  async #refreshIfAllowed(): Promise<void> {
    if (this.#inFlight !== undefined) {
      await this.#inFlight;
      return;
    }
    if (this.#clock.now().getTime() < this.#nextFetchAllowedAt) return;
    this.#inFlight = this.#refresh().finally(() => {
      this.#inFlight = undefined;
    });
    await this.#inFlight;
  }

  async #refresh(): Promise<void> {
    try {
      this.#keys = await parseJwks(await this.#download());
      this.#nextFetchAllowedAt = this.#clock.now().getTime() + this.#minRefreshIntervalMs;
    } catch {
      this.#nextFetchAllowedAt = this.#clock.now().getTime() + this.#failureBackoffMs;
    }
  }

  async #download(): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      const response = await Promise.race([
        this.#fetch(this.#url, { signal: controller.signal, redirect: "error" }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new JwksUnavailableError("timeout"));
          });
        }),
      ]);
      if (!response.ok) throw new JwksUnavailableError("http status");
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > JWKS_DEFAULTS.maxBodyBytes) throw new JwksUnavailableError("too large");
      const text = await response.text();
      if (text.length > JWKS_DEFAULTS.maxBodyBytes) throw new JwksUnavailableError("too large");
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new JwksUnavailableError("malformed json");
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
