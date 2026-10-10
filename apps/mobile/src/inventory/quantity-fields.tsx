import type { PackResponse, UnitResponse } from "@tali/shared";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Choice } from "../catalog/catalog-context";
import { Button, Field, styles } from "../onboarding/ui";
import { definitionFor, formatFactor } from "./inventory-format";
import { useInventoryStore } from "./inventory-context";
import type { ItemLabel } from "./inventory-store";
import type { QuantityEntry } from "./quantity-input";

export type PackChoices = readonly PackResponse[] | "loading" | "failed";

/**
 * A quantity typed in the item's stock unit, or whole packs (with an
 * optional loose quantity for counts). Nothing is converted here: pack
 * entries go to the API as typed.
 */
export function QuantityFields({
  label,
  stockUnit,
  units,
  packs,
  entry,
  onChange,
  allowLoose = false,
  error,
  disabled = false,
}: {
  readonly label: string;
  readonly stockUnit: string;
  readonly units: readonly UnitResponse[];
  readonly packs: PackChoices;
  readonly entry: QuantityEntry;
  readonly onChange: (entry: QuantityEntry) => void;
  readonly allowLoose?: boolean;
  readonly error: string | undefined;
  readonly disabled?: boolean;
}) {
  const definition = definitionFor(units, stockUnit);
  const packList: readonly PackResponse[] = packs === "loading" || packs === "failed" ? [] : packs;
  const scale = definition?.scale ?? 0;
  return (
    <View style={styles.field}>
      {packList.length === 0 ? null : (
        <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={`Enter ${label.toLowerCase()} as`}>
          <Choice
            label={stockUnit}
            selected={entry.kind === "direct"}
            disabled={disabled}
            onPress={() => {
              onChange({ kind: "direct", text: entry.kind === "direct" ? entry.text : "" });
            }}
          />
          {packList.map((pack) => (
            <Choice
              key={pack.id}
              label={`${pack.name} (${formatFactor(pack.factorMinor, definition, stockUnit)})`}
              selected={entry.kind === "pack" && entry.packId === pack.id}
              disabled={disabled}
              onPress={() => {
                onChange({
                  kind: "pack",
                  packId: pack.id,
                  packCount: entry.kind === "pack" ? entry.packCount : "",
                  loose: "",
                });
              }}
            />
          ))}
        </View>
      )}
      {entry.kind === "direct" ? (
        <Field
          label={`${label} (${stockUnit})`}
          value={entry.text}
          editable={!disabled}
          keyboardType={scale === 0 ? "number-pad" : "decimal-pad"}
          error={error}
          onChangeText={(text) => {
            onChange({ kind: "direct", text });
          }}
        />
      ) : (
        <>
          <Field
            label="Number of packs"
            value={entry.packCount}
            editable={!disabled}
            keyboardType="number-pad"
            error={error}
            onChangeText={(packCount) => {
              onChange({ ...entry, packCount });
            }}
          />
          {allowLoose ? (
            <Field
              label={`Loose ${stockUnit} (optional)`}
              value={entry.loose}
              editable={!disabled}
              keyboardType={scale === 0 ? "number-pad" : "decimal-pad"}
              onChangeText={(loose) => {
                onChange({ ...entry, loose });
              }}
            />
          ) : null}
        </>
      )}
      {packs === "failed" ? (
        <Text style={styles.hint}>Packs could not be loaded; enter the quantity in {stockUnit}.</Text>
      ) : null}
    </View>
  );
}

/** Finds stock items by name, SKU or barcode. Shows labels only, never quantities. */
export function ItemPicker({
  label,
  onPick,
  excluded = [],
  disabled = false,
}: {
  readonly label: string;
  readonly onPick: (item: ItemLabel) => void;
  readonly excluded?: readonly string[];
  readonly disabled?: boolean;
}) {
  const store = useInventoryStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly ItemLabel[] | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);

  async function find() {
    setSearching(true);
    setFailed(false);
    const outcome = await store.findItems(query);
    setSearching(false);
    if (outcome.status === "ok") setResults(outcome.value);
    else if (outcome.status === "failed") setFailed(true);
  }

  const shown = results?.filter((item) => !excluded.includes(item.variantId));
  return (
    <View style={styles.field}>
      <Field label={label} value={query} onChangeText={setQuery} editable={!disabled} />
      <Button
        label={searching ? "Finding…" : "Find item"}
        onPress={() => void find()}
        disabled={disabled || searching}
        secondary
      />
      {failed ? (
        <Text style={styles.error} accessibilityRole="alert">
          Items could not be found right now. Try again.
        </Text>
      ) : null}
      {shown === undefined ? null : shown.length === 0 ? (
        <Text>No matching stock items.</Text>
      ) : (
        shown.map((item) => (
          <Pressable
            key={item.variantId}
            accessibilityRole="button"
            accessibilityLabel={`Choose ${item.name}`}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => {
              onPick(item);
              setResults(undefined);
              setQuery("");
            }}
            style={styles.card}
          >
            <Text style={styles.strong}>{item.name}</Text>
            <Text>
              SKU: {item.sku ?? "None"}
              {item.productStatus === "ARCHIVED" ? " · Archived" : ""}
            </Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

/** Loads the item's ACTIVE packs once; failures fall back to direct entry. */
export function usePacks(productId: string | undefined): PackChoices {
  const store = useInventoryStore();
  const [packs, setPacks] = useState<{ readonly productId: string; readonly choices: PackChoices } | undefined>(
    undefined,
  );
  useEffect(() => {
    if (productId === undefined) return;
    let active = true;
    void store.listPacks(productId).then((outcome) => {
      if (active) setPacks({ productId, choices: outcome.status === "ok" ? outcome.value : "failed" });
    });
    return () => {
      active = false;
    };
  }, [store, productId]);
  if (productId === undefined) return [];
  return packs?.productId === productId ? packs.choices : "loading";
}
