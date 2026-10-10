import type { ReactNode } from "react";
import { createContext, useContext, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { describeFailure } from "../api/failure-messages";
import type { ApiFailure } from "../api/tali-api-client";
import { Button, styles } from "../onboarding/ui";
import type { InventoryAffordances } from "./affordances";
import type { InventorySnapshot, InventoryStore } from "./inventory-store";

const InventoryContext = createContext<InventoryStore | undefined>(undefined);
const AffordancesContext = createContext<InventoryAffordances | undefined>(undefined);

/** Provides the selected business's inventory store; it carries state and methods only, never credentials. */
export function InventoryProvider({
  store,
  allowed,
  children,
}: {
  readonly store: InventoryStore;
  readonly allowed: InventoryAffordances;
  readonly children: ReactNode;
}) {
  return (
    <InventoryContext.Provider value={store}>
      <AffordancesContext.Provider value={allowed}>{children}</AffordancesContext.Provider>
    </InventoryContext.Provider>
  );
}

export function useInventoryStore(): InventoryStore {
  const store = useContext(InventoryContext);
  if (store === undefined) throw new Error("useInventoryStore must be used inside InventoryProvider");
  return store;
}

export function useInventory(): InventorySnapshot {
  const store = useInventoryStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useAllowed(): InventoryAffordances {
  const allowed = useContext(AffordancesContext);
  if (allowed === undefined) throw new Error("useAllowed must be used inside InventoryProvider");
  return allowed;
}

/** Plain-language failure text; inventory screens may give CONFLICT and VERSION_CONFLICT their own wording. */
export function failureText(
  failure: ApiFailure,
  wording: { readonly conflict?: string; readonly versionConflict?: string } = {},
): string {
  if (failure.kind === "api-error") {
    if (failure.code === "CONFLICT" && wording.conflict !== undefined) return wording.conflict;
    if (failure.code === "VERSION_CONFLICT" && wording.versionConflict !== undefined) return wording.versionConflict;
  }
  return describeFailure(failure, { notFoundScope: "resource" }).text;
}

export function InventoryFailure({
  failure,
  conflict,
  versionConflict,
  onRetry,
  retryLabel = "Try again",
}: {
  readonly failure: ApiFailure;
  readonly conflict?: string;
  readonly versionConflict?: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}) {
  const retryable = describeFailure(failure, { notFoundScope: "resource" }).retryable;
  return (
    <View style={styles.alert} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <Text>
        {failureText(failure, {
          ...(conflict === undefined ? {} : { conflict }),
          ...(versionConflict === undefined ? {} : { versionConflict }),
        })}
      </Text>
      {retryable && onRetry !== undefined ? <Button label={retryLabel} onPress={onRetry} secondary /> : null}
    </View>
  );
}

export function Notice({ children }: { readonly children: ReactNode }) {
  return (
    <View style={styles.notice} accessibilityLiveRegion="polite">
      <Text>{children}</Text>
    </View>
  );
}

/** A labelled on/off filter, announced as a checkbox. */
export function Toggle({
  label,
  checked,
  onPress,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      onPress={onPress}
      style={[styles.button, checked ? styles.primary : styles.secondary]}
    >
      <Text style={checked ? styles.primaryText : styles.secondaryText}>
        {checked ? "✓ " : ""}
        {label}
      </Text>
    </Pressable>
  );
}

/** "LOW STOCK" exactly when the API says so; an archived item never shows it. */
export function LowStockBadge({ lowStock, archived }: { readonly lowStock: boolean; readonly archived: boolean }) {
  return lowStock && !archived ? <Text style={[styles.strong, styles.error]}>LOW STOCK</Text> : null;
}
