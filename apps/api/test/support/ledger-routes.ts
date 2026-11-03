/** Build 3 Slice 6: the only ledger routes. Every one is a read; the ledger has no write route. */
export const LEDGER_ROUTES = [
  "GET /v1/businesses/:businessId/ledger/accounts",
  "GET /v1/businesses/:businessId/ledger/balances",
  "GET /v1/businesses/:businessId/ledger/entries/:entryId",
] as const;
