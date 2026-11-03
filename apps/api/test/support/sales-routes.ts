/** Build 3 Slice 6: the only sales routes, all at the server-resolved default location. */
export const SALES_ROUTES = [
  "POST /v1/businesses/:businessId/sales",
  "GET /v1/businesses/:businessId/sales",
  "GET /v1/businesses/:businessId/sales/:saleId",
  "POST /v1/businesses/:businessId/sales/:saleId/reversal",
] as const;
