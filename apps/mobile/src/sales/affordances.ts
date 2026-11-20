/**
 * Which sales and ledger screens and actions the UI offers. UX only: the API
 * checks `sales:*` and `ledger:read` on every request, decides which sales a
 * CASHIER may read (their own) and still answers PERMISSION_DENIED, which is
 * shown. No contract exposes the caller's permissions, so this is the one
 * client copy of the ADR-011 and ADR-009 role mapping; nothing else in the
 * client reasons about roles.
 */
export interface SalesAffordances {
  /** The Sales section is shown: the role can read some sales (all, or its own). */
  readonly salesVisible: boolean;
  /** `sales:read`: every sale of the business; otherwise only the caller's own (`sales:read-own`). */
  readonly readAll: boolean;
  /** `sales:create`: the Sell tab. */
  readonly create: boolean;
  /** `sales:discount`: line discounts in the cart. */
  readonly discount: boolean;
  /** `sales:reverse`: full reversal of a POSTED sale. */
  readonly reverse: boolean;
  /** `ledger:read`: the read-only Ledger section. */
  readonly ledger: boolean;
}

const NONE: SalesAffordances = Object.freeze({
  salesVisible: false,
  readAll: false,
  create: false,
  discount: false,
  reverse: false,
  ledger: false,
});

const BY_ROLE: Readonly<Record<string, SalesAffordances>> = {
  OWNER: { salesVisible: true, readAll: true, create: true, discount: true, reverse: true, ledger: true },
  MANAGER: { salesVisible: true, readAll: true, create: true, discount: true, reverse: true, ledger: false },
  CASHIER: { salesVisible: true, readAll: false, create: true, discount: false, reverse: false, ledger: false },
  ACCOUNTANT: { salesVisible: true, readAll: true, create: false, discount: false, reverse: false, ledger: true },
  STOCK_KEEPER: NONE,
};

/** An unknown or missing role offers nothing. */
export function salesAffordances(role: string | undefined): SalesAffordances {
  const granted = role === undefined || !Object.hasOwn(BY_ROLE, role) ? undefined : BY_ROLE[role];
  return Object.freeze({ ...(granted ?? NONE) });
}
