import { useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useSessionStore } from "../auth/session-context";
import { formatMoney } from "../catalog/money-format";
import { Button, FailureNotice, Heading, Loading, styles } from "../onboarding/ui";
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
 * no posting, editing or journal browsing here. Nothing is stored on the device.
 */
export function LedgerScreen({ businessId }: { readonly businessId: string }) {
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

  return store === undefined ? <Loading label="Loading the ledger…" /> : <LedgerBody store={store} />;
}

function LedgerBody({ store }: { readonly store: LedgerStore }) {
  const session = useSessionStore();
  const ledger = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  if (ledger.businessUnavailable) {
    return (
      <View style={styles.alert} accessibilityRole="alert">
        <Text>This business is no longer available to you.</Text>
        <Button
          label="Switch business"
          onPress={() => {
            session.changeBusiness();
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Heading>Ledger</Heading>
      <Text style={styles.hint}>Read only. These are the accounts and balances Tali has recorded.</Text>
      {ledger.completeness === "incomplete" ? (
        <View style={styles.notice}>
          <Text>{VALUATION_INCOMPLETE}</Text>
        </View>
      ) : ledger.completeness === "unknown" ? (
        <View style={styles.notice}>
          <Text>{VALUATION_UNCHECKED}</Text>
        </View>
      ) : null}
      {ledger.phase === "loading" ? <Loading label="Loading the ledger…" /> : null}
      {ledger.phase === "failed" && ledger.failure !== undefined ? (
        <FailureNotice
          failure={ledger.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.load();
          }}
        />
      ) : null}
      {ledger.phase !== "ready" ? null : (
        <>
          <Text style={styles.label}>Accounts</Text>
          {ledger.accounts.map((account) => (
            <View key={account.accountId} style={styles.card} accessible accessibilityLabel={`Account ${account.code}`}>
              <Text style={styles.strong}>
                {account.code} {account.name}
              </Text>
              <Text>Type: {enumLabel(account.type)}</Text>
              <Text>Normal balance: {enumLabel(account.normalBalance)}</Text>
              <Text>System role: {enumLabel(account.systemRole)}</Text>
              <Text>Status: {enumLabel(account.status)}</Text>
            </View>
          ))}
          <Text style={styles.label}>Balances</Text>
          {ledger.balances.map((balance) => (
            <View key={balance.accountId} style={styles.card} accessible accessibilityLabel={`Balance ${balance.code}`}>
              <Text style={styles.strong}>
                {balance.code} {balance.name}
              </Text>
              <Text>Debit: {formatMoney(balance.debitTotal, ledger.currency)}</Text>
              <Text>Credit: {formatMoney(balance.creditTotal, ledger.currency)}</Text>
              <Text>Balance: {formatMoney(balance.balance, ledger.currency)}</Text>
            </View>
          ))}
        </>
      )}
    </View>
  );
}
