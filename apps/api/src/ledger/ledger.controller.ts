import { Controller, Get, Inject, Param, Query, UseGuards } from "@nestjs/common";
import type { BusinessContext } from "@tali/application";
import {
  type AccountBalancesResponse,
  EmptyQuerySchema,
  type JournalEntryResponse,
  LedgerEntryPathSchema,
  type LedgerAccountsResponse,
} from "@tali/shared";
import { BUSINESS_SCOPED_GUARDS, BUSINESS_SCOPED_PATH } from "../business/business-scoped.controller.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES } from "../composition/tokens.js";
import {
  toAccountBalancesResponse,
  toJournalEntryResponse,
  toLedgerAccountsResponse,
} from "../http/ledger-response-mappers.js";
import { ResolvedBusinessContext } from "../http/request-context.js";
import { parseRequest } from "../http/validation.js";

/**
 * Read-only ledger routes (ADR-009, ADR-011): the chart of accounts, derived
 * account balances and one journal entry, all with `ledger:read`. There is no
 * write route: journals are posted only by the application services that own
 * their sources. Ledger reads are business-wide and take the business context
 * as resolved by the guards; they are not bound to a location.
 */
@Controller(BUSINESS_SCOPED_PATH)
@UseGuards(...BUSINESS_SCOPED_GUARDS)
export class LedgerController {
  readonly #services: ApiServices;

  constructor(@Inject(API_SERVICES) services: ApiServices) {
    this.#services = services;
  }

  @Get("ledger/accounts")
  async listAccounts(
    @ResolvedBusinessContext() business: BusinessContext,
    @Query() query: unknown,
  ): Promise<LedgerAccountsResponse> {
    parseRequest(EmptyQuerySchema, query, "query");
    return toLedgerAccountsResponse(await this.#services.listLedgerAccounts.execute(business));
  }

  @Get("ledger/balances")
  async listBalances(
    @ResolvedBusinessContext() business: BusinessContext,
    @Query() query: unknown,
  ): Promise<AccountBalancesResponse> {
    parseRequest(EmptyQuerySchema, query, "query");
    return toAccountBalancesResponse(await this.#services.listAccountBalances.execute(business));
  }

  @Get("ledger/entries/:entryId")
  async getEntry(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<JournalEntryResponse> {
    const { entryId } = parseRequest(LedgerEntryPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const { entry } = await this.#services.getJournalEntry.execute(business, { entryId });
    return toJournalEntryResponse(entry);
  }
}
