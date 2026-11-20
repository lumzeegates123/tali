import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSessionStore } from "../auth/session-context";
import { useHardwareBack } from "../catalog/catalog-context";
import { newUuidV7 } from "../ids/uuidv7";
import { Button, Loading, styles } from "../onboarding/ui";
import { salesAffordances } from "./affordances";
import { SalesProvider, useSales, useSalesAllowed } from "./sales-context";
import { SaleDetailScreen, SalesHistoryScreen } from "./sales-history-screen";
import { SalesStore } from "./sales-store";
import { SellScreen } from "./sell-screen";

type SalesView =
  { readonly kind: "sell" } | { readonly kind: "history" } | { readonly kind: "sale"; readonly saleId: string };

const UNAVAILABLE = "This sale is not available. It may not exist, or you may not have access to it.";

/**
 * Sales of the selected business (plan 005 Slice 7). One `SalesStore` lives
 * as long as this section is mounted for one business; it is created in an
 * effect so a remount never reuses a disposed store, and disposing it drops
 * the cart, tenders and every idempotency key. Nothing is stored on the device.
 */
export function SalesScreen({ businessId, role }: { readonly businessId: string; readonly role: string | undefined }) {
  const session = useSessionStore();
  const [store, setStore] = useState<SalesStore | undefined>(undefined);

  useEffect(() => {
    const created = new SalesStore({ businessId, session, newIdempotencyKey: newUuidV7 });
    setStore(created);
    created.start();
    return () => {
      created.dispose();
    };
  }, [session, businessId]);

  if (store === undefined) return <Loading label="Loading sales…" />;
  return (
    <SalesProvider store={store} allowed={salesAffordances(role)}>
      <SalesBody />
    </SalesProvider>
  );
}

function SalesBody() {
  const session = useSessionStore();
  const allowed = useSalesAllowed();
  const { businessUnavailable } = useSales();
  const [view, setView] = useState<SalesView>(allowed.create ? { kind: "sell" } : { kind: "history" });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const tab = view.kind === "sell" ? "sell" : "history";

  const unavailable = useCallback(() => {
    setNotice(UNAVAILABLE);
    setView({ kind: "history" });
  }, []);

  if (businessUnavailable) {
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

  const tabs = allowed.create ? (["sell", "history"] as const) : (["history"] as const);

  return (
    <View style={styles.screen}>
      <View style={styles.row} accessibilityRole="tablist" accessibilityLabel="Sales sections">
        {tabs.map((value) => {
          const label = value === "sell" ? "Sell" : "Sales";
          return (
            <Pressable
              key={value}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: tab === value }}
              onPress={() => {
                setNotice(undefined);
                setView(value === "sell" ? { kind: "sell" } : { kind: "history" });
              }}
              style={[styles.button, tab === value ? styles.primary : styles.secondary]}
            >
              <Text style={tab === value ? styles.primaryText : styles.secondaryText}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      {notice === undefined ? null : (
        <View style={styles.notice} accessibilityLiveRegion="polite">
          <Text>{notice}</Text>
        </View>
      )}
      {view.kind === "sale" ? (
        <>
          <BackOnHardware
            onBack={() => {
              setView({ kind: "history" });
            }}
          />
          <SaleDetailScreen
            key={view.saleId}
            saleId={view.saleId}
            onBack={() => {
              setView({ kind: "history" });
            }}
            onUnavailable={unavailable}
          />
        </>
      ) : view.kind === "sell" && allowed.create ? (
        <SellScreen
          onCheckHistory={() => {
            setView({ kind: "history" });
          }}
        />
      ) : (
        <SalesHistoryScreen
          onOpen={(saleId) => {
            setNotice(undefined);
            setView({ kind: "sale", saleId });
          }}
        />
      )}
    </View>
  );
}

/** Android hardware back while a sale is open goes back to the sales list. */
function BackOnHardware({ onBack }: { readonly onBack: () => void }) {
  useHardwareBack(onBack);
  return null;
}
