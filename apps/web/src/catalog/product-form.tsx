"use client";

import type { CreateProductRequest, ProductResponse, UpdateProductRequest } from "@tali/shared";
import type { SyntheticEvent } from "react";
import { useState } from "react";
import { rejectedFields } from "../lib/api-client/failure-messages";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { FailureAlert } from "../onboarding/failure-alert";
import { TextField } from "../onboarding/text-field";
import type { CatalogAffordances } from "./affordances";
import { useCatalog, useCatalogStore, ViewHeading } from "./catalog-context";
import { categoryOptionLabel, useOutsideCategory } from "./category-label";
import { moneyInputError, moneyInputHint, parseMoneyInput } from "./money-format";

export type ProductFormMode =
  { readonly kind: "create" } | { readonly kind: "edit"; readonly product: ProductResponse };

/** Field values as typed; `categoryId` "" means no category. */
export interface ProductDraft {
  readonly name: string;
  readonly description: string;
  readonly categoryId: string;
  readonly sku: string;
  readonly barcode: string;
  readonly stockUnit: string;
  readonly trackInventory: boolean;
  readonly initialPrice: string;
}

const EMPTY_DRAFT: ProductDraft = {
  name: "",
  description: "",
  categoryId: "",
  sku: "",
  barcode: "",
  stockUnit: "",
  trackInventory: true,
  initialPrice: "",
};

export function draftFromProduct(product: ProductResponse): ProductDraft {
  return {
    name: product.name,
    description: product.description ?? "",
    categoryId: product.categoryId ?? "",
    sku: product.sku ?? "",
    barcode: product.barcode ?? "",
    stockUnit: product.stockUnit,
    trackInventory: product.trackInventory,
    initialPrice: "",
  };
}

/** Create omits empty optional fields; values are sent exactly as typed (normalization is server-side). */
export function createCommand(draft: ProductDraft): Omit<CreateProductRequest, "initialPrice"> {
  return {
    name: draft.name,
    ...(draft.description === "" ? {} : { description: draft.description }),
    ...(draft.categoryId === "" ? {} : { categoryId: draft.categoryId }),
    ...(draft.sku === "" ? {} : { sku: draft.sku }),
    ...(draft.barcode === "" ? {} : { barcode: draft.barcode }),
    stockUnit: draft.stockUnit,
    trackInventory: draft.trackInventory,
  };
}

/**
 * Edit sends only the fields the user changed from the values the form opened
 * with, plus the version to check (the reloaded one after a VERSION_CONFLICT,
 * so untouched fields never overwrite someone else's newer values). Clearing
 * an optional field sends null.
 */
export function updateCommand(
  product: ProductResponse,
  draft: ProductDraft,
  expectedVersion: number = product.version,
): UpdateProductRequest | undefined {
  const optional = (value: string): string | null => (value === "" ? null : value);
  const changes: Partial<Omit<UpdateProductRequest, "expectedVersion">> = {
    ...(draft.name === product.name ? {} : { name: draft.name }),
    ...(optional(draft.description) === product.description ? {} : { description: optional(draft.description) }),
    ...(optional(draft.categoryId) === product.categoryId ? {} : { categoryId: optional(draft.categoryId) }),
    ...(optional(draft.sku) === product.sku ? {} : { sku: optional(draft.sku) }),
    ...(optional(draft.barcode) === product.barcode ? {} : { barcode: optional(draft.barcode) }),
    ...(draft.stockUnit === product.stockUnit ? {} : { stockUnit: draft.stockUnit }),
    ...(draft.trackInventory === product.trackInventory ? {} : { trackInventory: draft.trackInventory }),
  };
  return Object.keys(changes).length === 0 ? undefined : { expectedVersion, ...changes };
}

function isCode(failure: ApiFailure | undefined, code: string): boolean {
  return failure?.kind === "api-error" && failure.code === code;
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "Name",
  description: "Description",
  categoryId: "Category",
  sku: "SKU",
  barcode: "Barcode",
  stockUnit: "Stock unit",
  trackInventory: "Track inventory",
  initialPrice: "Selling price",
};

/** One form model for create and edit. Edit never changes the price; price has its own flow. */
export function ProductForm({
  mode,
  allowed,
  onSaved,
  onCancel,
  onUnavailable,
}: {
  readonly mode: ProductFormMode;
  readonly allowed: CatalogAffordances;
  readonly onSaved: (product: ProductResponse) => void;
  readonly onCancel: () => void;
  readonly onUnavailable: () => void;
}) {
  const store = useCatalogStore();
  const { reference, categoryOptions, submitting } = useCatalog();
  const [base, setBase] = useState<ProductResponse | undefined>(mode.kind === "edit" ? mode.product : undefined);
  const [latest, setLatest] = useState<ProductResponse | undefined>(undefined);
  const [draft, setDraft] = useState<ProductDraft>(mode.kind === "edit" ? draftFromProduct(mode.product) : EMPTY_DRAFT);
  const [errors, setErrors] = useState<Partial<Record<keyof ProductDraft, string>>>({});
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const outside = useOutsideCategory(base?.categoryId ?? null);
  const busy = saving || (mode.kind === "create" && submitting.createProduct);
  const fieldErrors = rejectedFields(failure);
  const showPrice = mode.kind === "create" && allowed.canPrice;
  const title = mode.kind === "create" ? "Create product" : `Edit ${mode.product.name}`;

  function set<K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    save();
  }

  function save() {
    setFailure(undefined);
    setMessage(undefined);
    const nextErrors: Partial<Record<keyof ProductDraft, string>> = {};
    if (draft.name.trim() === "") nextErrors.name = "Enter a name.";
    if (draft.stockUnit === "") nextErrors.stockUnit = "Choose a stock unit.";
    let initialPrice: CreateProductRequest["initialPrice"];
    if (showPrice && draft.initialPrice.trim() !== "") {
      if (reference.currency === undefined) {
        nextErrors.initialPrice = "The business currency is not loaded yet.";
      } else {
        const parsed = parseMoneyInput(draft.initialPrice, reference.currency);
        if (parsed.ok) initialPrice = parsed.value;
        else nextErrors.initialPrice = moneyInputError(parsed.reason, reference.currency);
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    if (mode.kind === "create") {
      const command: CreateProductRequest = {
        ...createCommand(draft),
        ...(initialPrice === undefined ? {} : { initialPrice }),
      };
      void store.createProduct(command).then(settle);
      return;
    }
    if (base === undefined) return;
    const command = updateCommand(mode.product, draft, base.version);
    if (command === undefined) {
      setMessage("No changes to save.");
      return;
    }
    setSaving(true);
    void store.updateProduct(base.id, command).then((outcome) => {
      setSaving(false);
      settle(outcome);
    });
  }

  function settle(outcome: Awaited<ReturnType<typeof store.updateProduct>>) {
    if (outcome.status === "ok") {
      onSaved(outcome.value);
    } else if (outcome.status === "failed") {
      if (mode.kind === "edit" && isCode(outcome.failure, "NOT_FOUND")) onUnavailable();
      else setFailure(outcome.failure);
    }
  }

  /** VERSION_CONFLICT: the draft stays; the latest saved values are shown and the next submit uses their version. */
  function reloadLatest() {
    if (base === undefined) return;
    void store.getProduct(base.id).then((outcome) => {
      if (outcome.status === "ok") {
        setBase(outcome.value);
        setLatest(outcome.value);
        setFailure(undefined);
      } else if (outcome.status === "failed") {
        if (isCode(outcome.failure, "NOT_FOUND")) onUnavailable();
        else setFailure(outcome.failure);
      }
    });
  }

  const categoryChoices = [
    ...categoryOptions.items,
    ...(outside === undefined || categoryOptions.items.some((item) => item.id === outside.id) ? [] : [outside]),
  ];

  return (
    <div className="panel">
      <ViewHeading id="product-form-heading">{title}</ViewHeading>
      <form onSubmit={submit} noValidate aria-busy={busy}>
        <TextField
          id="product-name"
          label="Name"
          value={draft.name}
          onChange={(value) => {
            set("name", value);
          }}
          error={errors.name ?? (fieldErrors.includes("name") ? "This name was not accepted." : undefined)}
          disabled={busy}
        />
        <TextField
          id="product-description"
          label="Description (optional)"
          value={draft.description}
          onChange={(value) => {
            set("description", value);
          }}
          error={fieldErrors.includes("description") ? "This description was not accepted." : undefined}
          disabled={busy}
        />
        <div className="field">
          <label htmlFor="product-category">Category</label>
          <select
            id="product-category"
            value={draft.categoryId}
            disabled={busy}
            onChange={(event) => {
              set("categoryId", event.target.value);
            }}
          >
            <option value="">No category</option>
            {categoryChoices.map((category) => (
              <option key={category.id} value={category.id}>
                {categoryOptionLabel(category)}
              </option>
            ))}
          </select>
          {categoryOptions.truncated ? <p className="hint">Some categories could not be listed.</p> : null}
          {categoryOptions.phase === "failed" ? (
            <p className="hint">Categories could not be loaded. You can still save without a category.</p>
          ) : null}
        </div>
        <TextField
          id="product-sku"
          label="SKU (optional)"
          value={draft.sku}
          onChange={(value) => {
            set("sku", value);
          }}
          error={fieldErrors.includes("sku") ? "This SKU was not accepted." : undefined}
          disabled={busy}
        />
        <TextField
          id="product-barcode"
          label="Barcode (optional)"
          value={draft.barcode}
          onChange={(value) => {
            set("barcode", value);
          }}
          error={fieldErrors.includes("barcode") ? "This barcode was not accepted." : undefined}
          disabled={busy}
        />
        <div className="field">
          <label htmlFor="product-unit">Stock unit</label>
          <select
            id="product-unit"
            value={draft.stockUnit}
            disabled={busy || reference.phase !== "ready"}
            aria-invalid={errors.stockUnit === undefined ? undefined : true}
            aria-describedby={errors.stockUnit === undefined ? undefined : "product-unit-error"}
            onChange={(event) => {
              set("stockUnit", event.target.value);
            }}
          >
            <option value="">Choose a unit</option>
            {reference.units.map((unit) => (
              <option key={unit.code} value={unit.code}>
                {unit.code} ({unit.kind.toLowerCase()})
              </option>
            ))}
          </select>
          {errors.stockUnit === undefined ? null : (
            <p id="product-unit-error" className="field-error">
              Error: {errors.stockUnit}
            </p>
          )}
          {reference.phase === "failed" && reference.failure !== undefined ? (
            <FailureAlert
              failure={reference.failure}
              notFoundScope="business"
              onRetry={() => {
                void store.loadReference();
              }}
            />
          ) : null}
        </div>
        <div className="field">
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.trackInventory}
              disabled={busy}
              onChange={(event) => {
                set("trackInventory", event.target.checked);
              }}
            />
            Track inventory
          </label>
        </div>
        {showPrice && reference.currency !== undefined ? (
          <TextField
            id="product-initial-price"
            label="Selling price (optional)"
            value={draft.initialPrice}
            hint={moneyInputHint(reference.currency)}
            onChange={(value) => {
              set("initialPrice", value);
            }}
            error={
              errors.initialPrice ?? (fieldErrors.includes("initialPrice") ? "This price was not accepted." : undefined)
            }
            disabled={busy}
          />
        ) : null}
        {fieldErrors.length > 0 ? (
          <p className="hint">Check: {fieldErrors.map((field) => FIELD_LABELS[field] ?? field).join(", ")}.</p>
        ) : null}
        {failure === undefined ? null : (
          <FailureAlert failure={failure} notFoundScope="resource" onRetry={save} retryDisabled={busy} />
        )}
        {isCode(failure, "VERSION_CONFLICT") ? (
          <div className="actions">
            <button type="button" onClick={reloadLatest}>
              Reload latest
            </button>
          </div>
        ) : null}
        {latest === undefined ? null : (
          <div className="notice" role="status">
            <p>
              Latest saved values (version {latest.version}): {latest.name}; SKU {latest.sku ?? "none"}; barcode{" "}
              {latest.barcode ?? "none"}; unit {latest.stockUnit}. Your changes are still in the form; submit again to
              save them.
            </p>
          </div>
        )}
        {message === undefined ? null : <p role="status">{message}</p>}
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : mode.kind === "create" ? "Create product" : "Save changes"}
          </button>
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
