"use client";

import type { CategoryResponse } from "@tali/shared";
import { useEffect, useState } from "react";
import { useCatalog, useCatalogStore } from "./catalog-context";

/**
 * The product's current category when it is not among the ACTIVE options
 * (for example an archived category), read once by ID. Undefined while not
 * needed, loading or unavailable.
 */
export function useOutsideCategory(categoryId: string | null): CategoryResponse | undefined {
  const store = useCatalogStore();
  const { categoryOptions } = useCatalog();
  const listed = categoryId !== null && categoryOptions.items.some((item) => item.id === categoryId);
  const needed = categoryId !== null && categoryOptions.phase !== "loading" && !listed;
  const [fetched, setFetched] = useState<CategoryResponse | undefined>(undefined);

  useEffect(() => {
    if (!needed) return;
    let active = true;
    void store.getCategory(categoryId).then((outcome) => {
      if (active && outcome.status === "ok") setFetched(outcome.value);
    });
    return () => {
      active = false;
    };
  }, [store, categoryId, needed]);

  return needed && fetched?.id === categoryId ? fetched : undefined;
}

export function categoryOptionLabel(category: CategoryResponse): string {
  return category.status === "ARCHIVED" ? `${category.name} (archived)` : category.name;
}

/** Display text for a product's category. */
export function useCategoryLabel(categoryId: string | null): string {
  const { categoryOptions } = useCatalog();
  const outside = useOutsideCategory(categoryId);
  if (categoryId === null) return "None";
  const listed = categoryOptions.items.find((item) => item.id === categoryId);
  if (listed !== undefined) return listed.name;
  if (outside !== undefined) return categoryOptionLabel(outside);
  return categoryOptions.phase === "loading" ? "Loading…" : "Not available";
}
