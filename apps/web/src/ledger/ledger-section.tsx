"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { formatMoney } from "../catalog/money-format";
import { useSessionStore } from "../lib/auth/session-context";
import { FailureAlert } from "../onboarding/failure-alert";
import { LoadingState } from "../onboarding/screen-heading";
import { LedgerStore } from "./ledger-store";

export const VALUATION_INCOMPLETE =
  "Inventory value is incomplete because some stock needs valuation. Ledger balances show the values currently recorded by Tali.";
export const VALUATION_UNCHECKED = "Inventory valuation completeness could not be checked.";

/** "SALES_REVENUE" to "Sales revenue", for enum values shown as text. */
export function enumLabel(value: string): string {
  const words = value.toLowerCase().split("_").join(" ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * The read-only ledger of the selected business (`ledger:read`): the chart
 * of accounts and each account's recorded debit, credit and balance. There is
 * no posting, editing or journal browsing here.
 */
export function LedgerSection({ businessId }: { readonly businessId: string }) {
  const session = useSessionStore();
  const [store, setStore] = useState<LedgerStore | undefined>(undefined);

  useEffect(() => {
    const created = new LedgerStore({ businessId, session });
    setStore(created);
    void created.load();
    return () => {
      created.dispose();
    };
  }, [session, businessId]);

  return (
    <section aria-labelledby="ledger-heading" className="onboarding ledger">
      <h2 id="ledger-heading">Ledger</h2>
      {store === undefined ? <LoadingState label="Loading the ledger…" /> : <LedgerBody store={store} />}
    </section>
  );
}

function LedgerBody({ store }: { readonly store: LedgerStore }) {
  const session = useSessionStore();
  const ledger = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  if (ledger.businessUnavailable) {
    return (
      <div role="alert" className="alert">
        <p>This business is no longer available to you.</p>
        <button
          type="button"
          onClick={() => {
            session.changeBusiness();
          }}
        >
          Switch business
        </button>
      </div>
    );
  }

  return (
    <>
      <p className="hint">Read only. These are the accounts and balances Tali has recorded.</p>
      {ledger.completeness === "incomplete" ? (
        <p role="note" className="notice">
          {VALUATION_INCOMPLETE}
        </p>
      ) : ledger.completeness === "unknown" ? (
        <p role="note" className="notice">
          {VALUATION_UNCHECKED}
        </p>
      ) : null}
      {ledger.phase === "loading" ? <LoadingState label="Loading the ledger…" /> : null}
      {ledger.phase === "failed" && ledger.failure !== undefined ? (
        <FailureAlert
          failure={ledger.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.load();
          }}
        />
      ) : null}
      {ledger.phase !== "ready" ? null : (
        <>
          <h3>Accounts</h3>
          <table aria-label="Ledger accounts">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Normal balance</th>
                <th scope="col">System role</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {ledger.accounts.map((account) => (
                <tr key={account.accountId}>
                  <td>{account.code}</td>
                  <td>{account.name}</td>
                  <td>{enumLabel(account.type)}</td>
                  <td>{enumLabel(account.normalBalance)}</td>
                  <td>{enumLabel(account.systemRole)}</td>
                  <td>{enumLabel(account.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Balances</h3>
          <table aria-label="Account balances">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Debit</th>
                <th scope="col">Credit</th>
                <th scope="col">Balance</th>
              </tr>
            </thead>
            <tbody>
              {ledger.balances.map((balance) => (
                <tr key={balance.accountId}>
                  <td>
                    {balance.code} {balance.name}
                  </td>
                  <td>{formatMoney(balance.debitTotal, ledger.currency)}</td>
                  <td>{formatMoney(balance.creditTotal, ledger.currency)}</td>
                  <td>{formatMoney(balance.balance, ledger.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
