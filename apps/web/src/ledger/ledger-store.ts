import type { CurrencyDefinition } from "@tali/domain/kernel";
import type { AccountBalanceResponse, LedgerAccountResponse } from "@tali/shared";
import { currencyDefinition } from "../catalog/money-format";
import type { ApiFailure, ApiResult, TaliApiClient } from "../lib/api-client/tali-api-client";
import type {
  BusinessRequestCredentials,
  BusinessRequestPolicy,
  BusinessRequestResult,
} from "../lib/auth/session-store";

/** The part of the session the ledger uses: one request at a time for the selected business. */
export interface LedgerSession {
  businessRequest<T>(
    businessId: string,
    policy: BusinessRequestPolicy,
    send: (api: TaliApiClient, credentials: BusinessRequestCredentials) => Promise<ApiResult<T>>,
  ): Promise<BusinessRequestResult<T>>;
}

/**
 * `incomplete`: some stock needs valuation, so the recorded inventory value is
 * incomplete. `unknown`: that could not be checked. Amounts are never changed.
 */
export type ValuationCompleteness = "checking" | "complete" | "incomplete" | "unknown";

export interface LedgerSnapshot {
  readonly businessUnavailable: boolean;
  readonly phase: "loading" | "ready" | "failed";
  readonly failure: ApiFailure | undefined;
  readonly currency: CurrencyDefinition | undefined;
  readonly accounts: readonly LedgerAccountResponse[];
  readonly balances: readonly AccountBalanceResponse[];
  readonly completeness: ValuationCompleteness;
}

/**
 * The read-only ledger of one selected business (`ledger:read`), in memory
 * only and disposed with its section. It shows the chart of accounts and the
 * balances exactly as Tali recorded them; nothing here posts or edits.
 */
export class LedgerStore {
  readonly #businessId: string;
  readonly #session: LedgerSession;
  readonly #listeners = new Set<() => void>();
  #snapshot: LedgerSnapshot = Object.freeze<LedgerSnapshot>({
    businessUnavailable: false,
    phase: "loading",
    failure: undefined,
    currency: undefined,
    accounts: [],
    balances: [],
    completeness: "checking",
  });
  #disposed = false;
  #generation = 0;

  constructor(options: { readonly businessId: string; readonly session: LedgerSession }) {
    this.#businessId = options.businessId;
    this.#session = options.session;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): LedgerSnapshot => this.#snapshot;

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }

  /** Loads the currency, accounts and balances, and probes whether any stock needs valuation. */
  async load(): Promise<void> {
    const generation = ++this.#generation;
    this.#patch({ phase: "loading", failure: undefined, completeness: "checking" });
    const probe = this.#request((api, { token }) =>
      api.listInventoryItems(token, this.#businessId, { needsValuation: true, limit: 1 }),
    );
    const [currency, accounts, balances] = await Promise.all([
      this.#request((api, { token }) => api.getBusinessCurrency(token, this.#businessId)),
      this.#request((api, { token }) => api.listLedgerAccounts(token, this.#businessId)),
      this.#request((api, { token }) => api.listAccountBalances(token, this.#businessId)),
    ]);
    if (generation !== this.#generation) return;
    if (currency === undefined || accounts === undefined || balances === undefined) return;
    const failure = !currency.ok
      ? currency.failure
      : !accounts.ok
        ? accounts.failure
        : !balances.ok
          ? balances.failure
          : undefined;
    if (failure !== undefined) {
      this.#patch({ phase: "failed", failure });
    } else if (currency.ok && accounts.ok && balances.ok) {
      this.#patch({
        phase: "ready",
        currency: currencyDefinition(currency.value),
        accounts: accounts.value.items,
        balances: balances.value.items,
      });
    }
    const probed = await probe;
    if (generation !== this.#generation) return;
    this.#patch({
      completeness:
        probed === undefined || !probed.ok ? "unknown" : probed.value.items.length > 0 ? "incomplete" : "complete",
    });
  }

  async #request<T>(
    send: (api: TaliApiClient, credentials: BusinessRequestCredentials) => Promise<ApiResult<T>>,
  ): Promise<ApiResult<T> | undefined> {
    if (this.#disposed) return undefined;
    const result = await this.#session.businessRequest(this.#businessId, { notFoundScope: "business" }, send);
    if (this.#isDisposed()) return undefined;
    if (!("ok" in result)) {
      if (result.status === "businessUnavailable") this.#patch({ businessUnavailable: true });
      return undefined;
    }
    return result;
  }

  #isDisposed(): boolean {
    return this.#disposed;
  }

  #patch(changes: Partial<LedgerSnapshot>): void {
    if (this.#disposed) return;
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...changes });
    for (const listener of this.#listeners) listener();
  }
}
