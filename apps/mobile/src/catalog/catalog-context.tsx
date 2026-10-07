import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { BackHandler, Pressable, Text } from "react-native";
import { styles } from "../onboarding/ui";
import type { CatalogSnapshot, CatalogStore } from "./catalog-store";

const CatalogContext = createContext<CatalogStore | undefined>(undefined);

/** Provides the selected business's catalog store; it carries state and methods only, never credentials. */
export function CatalogProvider({ store, children }: { readonly store: CatalogStore; readonly children: ReactNode }) {
  return <CatalogContext.Provider value={store}>{children}</CatalogContext.Provider>;
}

export function useCatalogStore(): CatalogStore {
  const store = useContext(CatalogContext);
  if (store === undefined) throw new Error("useCatalogStore must be used inside CatalogProvider");
  return store;
}

export function useCatalog(): CatalogSnapshot {
  const store = useCatalogStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Android hardware back while a detail, create or edit view is open: goes
 * back to the previous catalog view and consumes the event. The listener is
 * removed when the view closes, so on the list back keeps its default.
 */
export function useHardwareBack(onBack: () => void): void {
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      latest.current();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, []);
}

/** One option of a single-choice group, announced as a radio button. */
export function Choice({
  label,
  selected,
  onPress,
  disabled = false,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, selected ? styles.primary : styles.secondary, disabled ? styles.disabled : null]}
    >
      <Text style={selected ? styles.primaryText : styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}
