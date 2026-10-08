"use client";

import type { CategoryResponse } from "@tali/shared";
import type { SyntheticEvent } from "react";
import { useEffect, useState } from "react";
import { rejectedFields } from "../lib/api-client/failure-messages";
import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { FailureAlert } from "../onboarding/failure-alert";
import { LoadingState } from "../onboarding/screen-heading";
import { TextField } from "../onboarding/text-field";
import type { CatalogAffordances } from "./affordances";
import { useCatalog, useCatalogStore, ViewHeading } from "./catalog-context";

function isCode(failure: ApiFailure | undefined, code: string): boolean {
  return failure?.kind === "api-error" && failure.code === code;
}

/** Categories: ACTIVE/ARCHIVED list, create (keyed), rename and archive with the loaded version. */
export function CategoriesPanel({ allowed }: { readonly allowed: CatalogAffordances }) {
  const store = useCatalogStore();
  const { categories, submitting } = useCatalog();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [createFailure, setCreateFailure] = useState<ApiFailure | undefined>(undefined);
  const [created, setCreated] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<CategoryResponse | undefined>(undefined);
  const [rowFailure, setRowFailure] = useState<ApiFailure | undefined>(undefined);

  useEffect(() => {
    void store.loadCategories("ACTIVE");
  }, [store]);

  function create() {
    setCreateFailure(undefined);
    setCreated(undefined);
    if (name.trim() === "") {
      setNameError("Enter a category name.");
      return;
    }
    setNameError(undefined);
    void store.createCategory({ name }).then((outcome) => {
      if (outcome.status === "ok") {
        setName("");
        setCreated(`Category ${outcome.value.name} created.`);
      } else if (outcome.status === "failed") {
        setCreateFailure(outcome.failure);
      }
    });
  }

  function submitCreate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    create();
  }

  function archive(category: CategoryResponse) {
    setRowFailure(undefined);
    void store.archiveCategory(category.id, { expectedVersion: category.version }).then((outcome) => {
      if (outcome.status === "failed") setRowFailure(outcome.failure);
    });
  }

  return (
    <div className="panel">
      <ViewHeading id="categories-heading">Categories</ViewHeading>
      <fieldset className="field">
        <legend className="label">Status</legend>
        {(["ACTIVE", "ARCHIVED"] as const).map((status) => (
          <label key={status} className="choice">
            <input
              type="radio"
              name="category-status"
              value={status}
              checked={categories.status === status}
              onChange={() => {
                setEditing(undefined);
                void store.loadCategories(status);
              }}
            />
            {status === "ACTIVE" ? "Active" : "Archived"}
          </label>
        ))}
      </fieldset>
      {categories.phase === "loading" ? <LoadingState label="Loading categories…" /> : null}
      {categories.phase === "failed" && categories.failure !== undefined ? (
        <FailureAlert
          failure={categories.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadCategories(categories.status);
          }}
        />
      ) : null}
      {rowFailure === undefined ? null : (
        <>
          <FailureAlert failure={rowFailure} notFoundScope="resource" />
          {isCode(rowFailure, "VERSION_CONFLICT") || isCode(rowFailure, "NOT_FOUND") ? (
            <div className="actions">
              <button
                type="button"
                onClick={() => {
                  setRowFailure(undefined);
                  setEditing(undefined);
                  void store.loadCategories(categories.status);
                }}
              >
                Reload latest
              </button>
            </div>
          ) : null}
        </>
      )}
      {categories.phase === "ready" && categories.items.length === 0 ? <p role="status">No categories.</p> : null}
      {categories.items.length === 0 ? null : (
        <ul className="catalog-list" aria-label="Categories">
          {categories.items.map((category) =>
            editing?.id === category.id ? (
              <li key={category.id} className="catalog-row">
                <RenameForm
                  category={editing}
                  onDone={() => {
                    setEditing(undefined);
                  }}
                  onUnavailable={(failure) => {
                    setEditing(undefined);
                    setRowFailure(failure);
                    void store.loadCategories(categories.status);
                  }}
                />
              </li>
            ) : (
              <li key={category.id} className="catalog-row">
                <span className="catalog-name">{category.name}</span>
                <span>Status: {category.status === "ACTIVE" ? "Active" : "Archived"}</span>
                {allowed.canManage && category.status === "ACTIVE" ? (
                  <span className="actions">
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Rename ${category.name}`}
                      onClick={() => {
                        setRowFailure(undefined);
                        setEditing(category);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Archive ${category.name}`}
                      onClick={() => {
                        archive(category);
                      }}
                    >
                      Archive
                    </button>
                  </span>
                ) : null}
              </li>
            ),
          )}
        </ul>
      )}
      {categories.moreFailure === undefined ? null : (
        <FailureAlert
          failure={categories.moreFailure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadMoreCategories();
          }}
        />
      )}
      {categories.nextCursor === null || categories.phase !== "ready" ? null : (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={categories.loadingMore}
            onClick={() => {
              void store.loadMoreCategories();
            }}
          >
            {categories.loadingMore ? "Loading more…" : "Show more categories"}
          </button>
        </div>
      )}
      {allowed.canManage ? (
        <form onSubmit={submitCreate} noValidate aria-busy={submitting.createCategory}>
          <h4>Create a category</h4>
          <TextField
            id="category-name"
            label="Category name"
            value={name}
            onChange={setName}
            disabled={submitting.createCategory}
            error={
              nameError ?? (rejectedFields(createFailure).includes("name") ? "This name was not accepted." : undefined)
            }
          />
          {createFailure === undefined ? null : (
            <FailureAlert
              failure={createFailure}
              notFoundScope="resource"
              onRetry={create}
              retryDisabled={submitting.createCategory}
            />
          )}
          {created === undefined ? null : <p role="status">{created}</p>}
          <div className="actions">
            <button type="submit" disabled={submitting.createCategory}>
              {submitting.createCategory ? "Creating category…" : "Create category"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/**
 * Renames one category with the version it was loaded at. VERSION_CONFLICT
 * keeps the typed name and offers Reload latest, whose version the next save
 * uses; nothing is retried automatically. NOT_FOUND leaves the form.
 */
function RenameForm({
  category,
  onDone,
  onUnavailable,
}: {
  readonly category: CategoryResponse;
  readonly onDone: () => void;
  readonly onUnavailable: (failure: ApiFailure) => void;
}) {
  const store = useCatalogStore();
  const [base, setBase] = useState(category);
  const [name, setName] = useState(category.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const [latest, setLatest] = useState<CategoryResponse | undefined>(undefined);

  function fail(outcomeFailure: ApiFailure) {
    if (isCode(outcomeFailure, "NOT_FOUND")) onUnavailable(outcomeFailure);
    else setFailure(outcomeFailure);
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === "") {
      setError("Enter a category name.");
      return;
    }
    setError(undefined);
    if (name === base.name) {
      onDone();
      return;
    }
    setFailure(undefined);
    setSaving(true);
    void store.updateCategory(base.id, { expectedVersion: base.version, name }).then((outcome) => {
      setSaving(false);
      if (outcome.status === "ok") onDone();
      else if (outcome.status === "failed") fail(outcome.failure);
    });
  }

  function reloadLatest() {
    void store.getCategory(base.id).then((outcome) => {
      if (outcome.status === "ok") {
        setBase(outcome.value);
        setLatest(outcome.value);
        setFailure(undefined);
      } else if (outcome.status === "failed") {
        fail(outcome.failure);
      }
    });
  }

  return (
    <form onSubmit={submit} noValidate aria-busy={saving}>
      <TextField
        id={`rename-${base.id}`}
        label={`New name for ${base.name}`}
        value={name}
        onChange={setName}
        disabled={saving}
        error={error ?? (rejectedFields(failure).includes("name") ? "This name was not accepted." : undefined)}
      />
      {failure === undefined ? null : <FailureAlert failure={failure} notFoundScope="resource" />}
      {isCode(failure, "VERSION_CONFLICT") ? (
        <div className="actions">
          <button type="button" onClick={reloadLatest}>
            Reload latest
          </button>
        </div>
      ) : null}
      {latest === undefined ? null : (
        <p className="notice" role="status">
          Latest saved name (version {latest.version}): {latest.name}. Your new name is still in the form; save again to
          apply it.
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save name"}
        </button>
        <button type="button" className="secondary" onClick={onDone} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
