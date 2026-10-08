import type { CategoryResponse, CreateProductRequest, ProductResponse, UpdateProductRequest } from "@tali/shared";
import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { rejectedFields } from "../api/failure-messages";
import type { ApiFailure } from "../api/tali-api-client";
import { Button, FailureNotice, Field, Heading, styles } from "../onboarding/ui";
import type { CatalogAffordances } from "./affordances";
import { Choice, useCatalog, useCatalogStore, useHardwareBack } from "./catalog-context";
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

/** One form model for create and edit. Edit never changes the price; price has its own form. */
export function ProductFormScreen({
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
  const [outside, setOutside] = useState<CategoryResponse | undefined>(undefined);
  useHardwareBack(onCancel);
  const busy = saving || (mode.kind === "create" && submitting.createProduct);
  const fieldErrors = rejectedFields(failure);
  const showPrice = mode.kind === "create" && allowed.canPrice;
  const currentCategoryId = base?.categoryId ?? null;
  const needsLookup =
    currentCategoryId !== null &&
    categoryOptions.phase !== "loading" &&
    !categoryOptions.items.some((item) => item.id === currentCategoryId);

  useEffect(() => {
    if (!needsLookup) return;
    let active = true;
    void store.getCategory(currentCategoryId).then((outcome) => {
      if (active && outcome.status === "ok") setOutside(outcome.value);
    });
    return () => {
      active = false;
    };
  }, [store, currentCategoryId, needsLookup]);

  function set<K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function settle(outcome: Awaited<ReturnType<typeof store.updateProduct>>) {
    if (outcome.status === "ok") {
      onSaved(outcome.value);
    } else if (outcome.status === "failed") {
      if (mode.kind === "edit" && isCode(outcome.failure, "NOT_FOUND")) onUnavailable();
      else setFailure(outcome.failure);
    }
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
      void store
        .createProduct({ ...createCommand(draft), ...(initialPrice === undefined ? {} : { initialPrice }) })
        .then(settle);
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
    ...(outside === undefined || !needsLookup || outside.id !== currentCategoryId ? [] : [outside]),
  ];

  return (
    <View style={styles.screen}>
      <Heading>{mode.kind === "create" ? "Create product" : `Edit ${mode.product.name}`}</Heading>
      <Field
        label="Name"
        value={draft.name}
        onChangeText={(value) => {
          set("name", value);
        }}
        editable={!busy}
        error={errors.name ?? (fieldErrors.includes("name") ? "This name was not accepted." : undefined)}
      />
      <Field
        label="Description (optional)"
        value={draft.description}
        onChangeText={(value) => {
          set("description", value);
        }}
        editable={!busy}
        error={fieldErrors.includes("description") ? "This description was not accepted." : undefined}
      />
      <View style={styles.field} accessibilityRole="radiogroup" accessibilityLabel="Category">
        <Text style={styles.label}>Category</Text>
        <Choice
          label="No category"
          selected={draft.categoryId === ""}
          disabled={busy}
          onPress={() => {
            set("categoryId", "");
          }}
        />
        {categoryChoices.map((category) => (
          <Choice
            key={category.id}
            label={category.status === "ARCHIVED" ? `${category.name} (archived)` : category.name}
            selected={draft.categoryId === category.id}
            disabled={busy}
            onPress={() => {
              set("categoryId", category.id);
            }}
          />
        ))}
        {categoryOptions.truncated ? <Text style={styles.hint}>Some categories could not be listed.</Text> : null}
        {categoryOptions.phase === "failed" ? (
          <Text style={styles.hint}>Categories could not be loaded. You can still save without a category.</Text>
        ) : null}
      </View>
      <Field
        label="SKU (optional)"
        value={draft.sku}
        onChangeText={(value) => {
          set("sku", value);
        }}
        editable={!busy}
        error={fieldErrors.includes("sku") ? "This SKU was not accepted." : undefined}
      />
      <Field
        label="Barcode (optional)"
        value={draft.barcode}
        onChangeText={(value) => {
          set("barcode", value);
        }}
        editable={!busy}
        error={fieldErrors.includes("barcode") ? "This barcode was not accepted." : undefined}
      />
      <View style={styles.field} accessibilityRole="radiogroup" accessibilityLabel="Stock unit">
        <Text style={styles.label}>Stock unit</Text>
        {reference.units.map((unit) => (
          <Choice
            key={unit.code}
            label={`${unit.code} (${unit.kind.toLowerCase()})`}
            selected={draft.stockUnit === unit.code}
            disabled={busy}
            onPress={() => {
              set("stockUnit", unit.code);
            }}
          />
        ))}
        {errors.stockUnit === undefined ? null : <Text style={styles.error}>Error: {errors.stockUnit}</Text>}
        {reference.phase === "failed" && reference.failure !== undefined ? (
          <FailureNotice
            failure={reference.failure}
            notFoundScope="business"
            onRetry={() => {
              void store.loadReference();
            }}
          />
        ) : null}
      </View>
      <View style={styles.row}>
        <Switch
          accessibilityLabel="Track inventory"
          value={draft.trackInventory}
          disabled={busy}
          onValueChange={(value) => {
            set("trackInventory", value);
          }}
        />
        <Text>Track inventory</Text>
      </View>
      {showPrice && reference.currency !== undefined ? (
        <Field
          label="Selling price (optional)"
          hint={moneyInputHint(reference.currency)}
          value={draft.initialPrice}
          onChangeText={(value) => {
            set("initialPrice", value);
          }}
          editable={!busy}
          error={
            errors.initialPrice ?? (fieldErrors.includes("initialPrice") ? "This price was not accepted." : undefined)
          }
        />
      ) : null}
      {fieldErrors.length > 0 ? (
        <Text style={styles.hint}>Check: {fieldErrors.map((field) => FIELD_LABELS[field] ?? field).join(", ")}.</Text>
      ) : null}
      {failure === undefined ? null : (
        <FailureNotice failure={failure} notFoundScope="resource" onRetry={save} retryDisabled={busy} />
      )}
      {isCode(failure, "VERSION_CONFLICT") ? <Button label="Reload latest" onPress={reloadLatest} /> : null}
      {latest === undefined ? null : (
        <View style={styles.notice} accessibilityLiveRegion="polite">
          <Text>
            Latest saved values (version {latest.version}): {latest.name}; SKU {latest.sku ?? "none"}; barcode{" "}
            {latest.barcode ?? "none"}; unit {latest.stockUnit}. Your changes are still in the form; submit again to
            save them.
          </Text>
        </View>
      )}
      {message === undefined ? null : <Text accessibilityLiveRegion="polite">{message}</Text>}
      <Button
        label={busy ? "Saving…" : mode.kind === "create" ? "Create product" : "Save changes"}
        onPress={save}
        disabled={busy}
        busy={busy}
      />
      <Button label="Cancel" onPress={onCancel} disabled={busy} secondary />
    </View>
  );
}
