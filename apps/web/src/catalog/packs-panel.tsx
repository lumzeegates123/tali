"use client";

import type { PackResponse, ProductResponse } from "@tali/shared";
import type { SyntheticEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { rejectedFields } from "../lib/api-client/failure-messages";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { FailureAlert } from "../onboarding/failure-alert";
import { LoadingState } from "../onboarding/screen-heading";
import { TextField } from "../onboarding/text-field";
import type { CatalogAffordances } from "./affordances";
import { useCatalog, useCatalogStore } from "./catalog-context";
import { factorInputHint, formatFactor, parseFactorInput, unitDefinition } from "./quantity-format";

type PackStatus = "ACTIVE" | "RETIRED";

interface PackListState {
  readonly phase: "loading" | "ready" | "failed";
  readonly items: readonly PackResponse[];
  readonly nextCursor: string | null;
  readonly failure: ApiFailure | undefined;
  readonly loadingMore: boolean;
}

const LOADING: PackListState = {
  phase: "loading",
  items: [],
  nextCursor: null,
  failure: undefined,
  loadingMore: false,
};

/** Packs of one product: the quantity per pack is entered and shown in the product's stock unit. */
export function PacksPanel({
  product,
  allowed,
}: {
  readonly product: ProductResponse;
  readonly allowed: CatalogAffordances;
}) {
  const store = useCatalogStore();
  const { reference, submitting } = useCatalog();
  const [status, setStatus] = useState<PackStatus>("ACTIVE");
  const [list, setList] = useState<PackListState>(LOADING);
  const [reload, setReload] = useState(0);
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const [retireFailure, setRetireFailure] = useState<ApiFailure | undefined>(undefined);
  const generation = useRef(0);
  const unitResponse = reference.units.find((unit) => unit.code === product.stockUnit);
  const unit = unitResponse === undefined ? undefined : unitDefinition(unitResponse);

  useEffect(() => {
    const current = ++generation.current;
    setList(LOADING);
    void store.listPacks(product.id, status).then((outcome) => {
      if (current !== generation.current || outcome.status === "ignored") return;
      setList(
        outcome.status === "ok"
          ? { ...LOADING, phase: "ready", items: outcome.value.items, nextCursor: outcome.value.nextCursor }
          : { ...LOADING, phase: "failed", failure: outcome.failure },
      );
    });
  }, [store, product.id, status, reload]);

  function more() {
    const cursor = list.nextCursor;
    if (cursor === null || list.loadingMore) return;
    const current = generation.current;
    setList((value) => ({ ...value, loadingMore: true, failure: undefined }));
    void store.listPacks(product.id, status, cursor).then((outcome) => {
      if (current !== generation.current || outcome.status === "ignored") return;
      setList((value) =>
        outcome.status === "ok"
          ? {
              ...value,
              loadingMore: false,
              items: [
                ...value.items,
                ...outcome.value.items.filter((item) => !value.items.some((seen) => seen.id === item.id)),
              ],
              nextCursor: outcome.value.nextCursor,
            }
          : { ...value, loadingMore: false, failure: outcome.failure },
      );
    });
  }

  function add() {
    if (unit === undefined) return;
    setFailure(undefined);
    const parsed = parseFactorInput(quantity, unit);
    const missingName = name.trim() === "";
    setNameError(missingName ? "Enter a pack name." : undefined);
    setError(
      parsed.ok ? undefined : parsed.reason === "empty" ? "Enter the quantity per pack." : factorInputHint(unit),
    );
    if (missingName || !parsed.ok) return;
    void store.addPack(product.id, { name, factorMinor: parsed.factorMinor }).then((outcome) => {
      if (outcome.status === "ok") {
        setName("");
        setQuantity("");
        setReload((value) => value + 1);
      } else if (outcome.status === "failed") {
        setFailure(outcome.failure);
      }
    });
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    add();
  }

  function retire(pack: PackResponse) {
    setRetireFailure(undefined);
    void store.retirePack(pack.id).then((outcome) => {
      if (outcome.status === "ok") setReload((value) => value + 1);
      else if (outcome.status === "failed") setRetireFailure(outcome.failure);
    });
  }

  return (
    <section aria-labelledby="packs-heading" className="panel">
      <h3 id="packs-heading">Packs</h3>
      <fieldset className="field">
        <legend className="label">Pack status</legend>
        {(["ACTIVE", "RETIRED"] as const).map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="pack-status"
              value={value}
              checked={status === value}
              onChange={() => {
                setStatus(value);
              }}
            />
            {value === "ACTIVE" ? "Active" : "Retired"}
          </label>
        ))}
      </fieldset>
      {list.phase === "loading" ? <LoadingState label="Loading packs…" /> : null}
      {list.failure === undefined ? null : (
        <FailureAlert
          failure={list.failure}
          notFoundScope="resource"
          onRetry={() => {
            if (list.phase === "failed") setReload((value) => value + 1);
            else more();
          }}
        />
      )}
      {retireFailure === undefined ? null : <FailureAlert failure={retireFailure} notFoundScope="resource" />}
      {list.phase === "ready" && list.items.length === 0 ? <p>No packs.</p> : null}
      {list.items.length === 0 ? null : (
        <table>
          <thead>
            <tr>
              <th scope="col">Pack</th>
              <th scope="col">Quantity per pack</th>
              <th scope="col">Status</th>
              {allowed.canManage ? <th scope="col">Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {list.items.map((pack) => (
              <tr key={pack.id}>
                <td>{pack.name}</td>
                <td>{formatFactor(pack.factorMinor, unit, product.stockUnit)}</td>
                <td>{pack.status === "ACTIVE" ? "Active" : "Retired"}</td>
                {allowed.canManage ? (
                  <td>
                    {pack.status === "ACTIVE" ? (
                      <button
                        type="button"
                        className="secondary"
                        aria-label={`Retire ${pack.name}`}
                        onClick={() => {
                          retire(pack);
                        }}
                      >
                        Retire
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {list.nextCursor === null ? null : (
        <div className="actions">
          <button type="button" className="secondary" disabled={list.loadingMore} onClick={more}>
            {list.loadingMore ? "Loading more…" : "Show more packs"}
          </button>
        </div>
      )}
      {allowed.canManage && unit !== undefined ? (
        <form onSubmit={submit} noValidate aria-busy={submitting.addPack}>
          <h4>Add a pack</h4>
          <TextField
            id="pack-name"
            label="Pack name"
            value={name}
            onChange={setName}
            disabled={submitting.addPack}
            error={
              nameError ?? (rejectedFields(failure).includes("name") ? "This pack name was not accepted." : undefined)
            }
          />
          <TextField
            id="pack-quantity"
            label={`Quantity per pack, in ${unit.code}`}
            value={quantity}
            hint={factorInputHint(unit)}
            onChange={setQuantity}
            disabled={submitting.addPack}
            error={
              error ?? (rejectedFields(failure).includes("factorMinor") ? "This quantity was not accepted." : undefined)
            }
          />
          {failure === undefined ? null : (
            <FailureAlert failure={failure} notFoundScope="resource" onRetry={add} retryDisabled={submitting.addPack} />
          )}
          <div className="actions">
            <button type="submit" disabled={submitting.addPack}>
              {submitting.addPack ? "Adding pack…" : "Add pack"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
