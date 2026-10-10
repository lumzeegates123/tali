"use client";

import type { PackResponse, UnitResponse } from "@tali/shared";
import { useEffect, useState } from "react";
import { formatFactor } from "../catalog/quantity-format";
import { definitionFor } from "./inventory-format";
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
  idPrefix,
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
  readonly idPrefix: string;
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
  const errorId = `${idPrefix}-error`;
  return (
    <div className="field">
      {packList.length === 0 ? null : (
        <>
          <label htmlFor={`${idPrefix}-mode`}>Enter {label.toLowerCase()} as</label>
          <select
            id={`${idPrefix}-mode`}
            value={entry.kind === "pack" ? entry.packId : ""}
            disabled={disabled}
            onChange={(event) => {
              const packId = event.target.value;
              onChange(
                packId === ""
                  ? { kind: "direct", text: entry.kind === "direct" ? entry.text : "" }
                  : { kind: "pack", packId, packCount: entry.kind === "pack" ? entry.packCount : "", loose: "" },
              );
            }}
          >
            <option value="">{stockUnit}</option>
            {packList.map((pack) => (
              <option key={pack.id} value={pack.id}>
                {pack.name} ({formatFactor(pack.factorMinor, definition, stockUnit)})
              </option>
            ))}
          </select>
        </>
      )}
      {entry.kind === "direct" ? (
        <>
          <label htmlFor={`${idPrefix}-quantity`}>
            {label} ({stockUnit})
          </label>
          <input
            id={`${idPrefix}-quantity`}
            inputMode="decimal"
            autoComplete="off"
            value={entry.text}
            disabled={disabled}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={error === undefined ? undefined : errorId}
            onChange={(event) => {
              onChange({ kind: "direct", text: event.target.value });
            }}
          />
        </>
      ) : (
        <>
          <label htmlFor={`${idPrefix}-packs`}>Number of packs</label>
          <input
            id={`${idPrefix}-packs`}
            inputMode="numeric"
            autoComplete="off"
            value={entry.packCount}
            disabled={disabled}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={error === undefined ? undefined : errorId}
            onChange={(event) => {
              onChange({ ...entry, packCount: event.target.value });
            }}
          />
          {allowLoose ? (
            <>
              <label htmlFor={`${idPrefix}-loose`}>Loose {stockUnit} (optional)</label>
              <input
                id={`${idPrefix}-loose`}
                inputMode="decimal"
                autoComplete="off"
                value={entry.loose}
                disabled={disabled}
                onChange={(event) => {
                  onChange({ ...entry, loose: event.target.value });
                }}
              />
            </>
          ) : null}
        </>
      )}
      {packs === "failed" ? (
        <p className="hint">Packs could not be loaded; enter the quantity in {stockUnit}.</p>
      ) : null}
      {error === undefined ? null : (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </div>
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
    <div className="field" role="group" aria-label={label}>
      <label htmlFor="item-picker-search">{label}</label>
      <input
        id="item-picker-search"
        value={query}
        disabled={disabled}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void find();
          }
        }}
      />
      <div className="actions">
        <button type="button" className="secondary" disabled={disabled || searching} onClick={() => void find()}>
          {searching ? "Finding…" : "Find item"}
        </button>
      </div>
      {failed ? (
        <p role="alert" className="field-error">
          Items could not be found right now. Try again.
        </p>
      ) : null}
      {shown === undefined ? null : shown.length === 0 ? (
        <p>No matching stock items.</p>
      ) : (
        <ul className="catalog-list" aria-label="Matching items">
          {shown.map((item) => (
            <li key={item.variantId} className="catalog-row">
              <span className="catalog-name">{item.name}</span>
              <span>SKU: {item.sku ?? "None"}</span>
              {item.productStatus === "ARCHIVED" ? <span>Archived</span> : null}
              <button
                type="button"
                className="secondary"
                aria-label={`Choose ${item.name}`}
                disabled={disabled}
                onClick={() => {
                  onPick(item);
                  setResults(undefined);
                  setQuery("");
                }}
              >
                Choose
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
