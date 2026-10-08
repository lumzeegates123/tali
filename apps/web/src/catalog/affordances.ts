/**
 * Which catalog actions the UI offers for a membership role. UX only: the API
 * checks `product:manage` and `product:price` on every request, and a
 * PERMISSION_DENIED answer is still shown.
 */
export interface CatalogAffordances {
  /** Create, edit, archive and reactivate products; manage categories and packs. */
  readonly canManage: boolean;
  /** Set a selling price, including the initial price on create. */
  readonly canPrice: boolean;
}

const READ_ONLY: CatalogAffordances = Object.freeze({ canManage: false, canPrice: false });

const BY_ROLE: Readonly<Record<string, CatalogAffordances>> = {
  OWNER: Object.freeze({ canManage: true, canPrice: true }),
  MANAGER: Object.freeze({ canManage: true, canPrice: true }),
  STOCK_KEEPER: Object.freeze({ canManage: true, canPrice: false }),
  CASHIER: READ_ONLY,
  ACCOUNTANT: READ_ONLY,
};

/** An unknown or missing role gets read-only affordances. */
export function catalogAffordances(role: string | undefined): CatalogAffordances {
  return (role === undefined ? undefined : BY_ROLE[role]) ?? READ_ONLY;
}
