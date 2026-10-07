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
                  onFailure={setRowFailure}
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

function RenameForm({
  category,
  onDone,
  onFailure,
}: {
  readonly category: CategoryResponse;
  readonly onDone: () => void;
  readonly onFailure: (failure: ApiFailure) => void;
}) {
  const store = useCatalogStore();
  const [name, setName] = useState(category.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === "") {
      setError("Enter a category name.");
      return;
    }
    if (name === category.name) {
      onDone();
      return;
    }
    setSaving(true);
    void store.updateCategory(category.id, { expectedVersion: category.version, name }).then((outcome) => {
      setSaving(false);
      if (outcome.status === "ok") onDone();
      else if (outcome.status === "failed") onFailure(outcome.failure);
    });
  }

  return (
    <form onSubmit={submit} noValidate aria-busy={saving}>
      <TextField
        id={`rename-${category.id}`}
        label={`New name for ${category.name}`}
        value={name}
        onChange={setName}
        disabled={saving}
        error={error}
      />
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
