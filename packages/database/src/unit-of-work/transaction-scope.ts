import type { TransactionScope } from "@tali/application";
import type { Prisma } from "../generated/prisma/client.js";

export type TransactionClient = Prisma.TransactionClient;

/**
 * Maps the application's opaque TransactionScope to the Prisma transaction
 * client behind it. The scope object carries nothing: application code cannot
 * reach Prisma through it, and a scope is only usable while its transaction
 * is open.
 */
const openTransactions = new WeakMap<TransactionScope, TransactionClient>();

export function openScope(client: TransactionClient): TransactionScope {
  const scope = Object.freeze({}) as unknown as TransactionScope;
  openTransactions.set(scope, client);
  return scope;
}

export function closeScope(scope: TransactionScope): void {
  openTransactions.delete(scope);
}

/** For repository adapters inside packages/database only. */
export function transactionClient(scope: TransactionScope): TransactionClient {
  const client = openTransactions.get(scope);
  if (client === undefined) {
    throw new Error(
      "TransactionScope is not an open PrismaUnitOfWork transaction (it was committed, rolled back, or never opened here)",
    );
  }
  return client;
}
