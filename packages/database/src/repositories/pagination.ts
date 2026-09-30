import type { Page, PageRequest } from "@tali/application";

/** Prisma arguments for one keyset page ordered by `id`: one extra row reveals whether another page exists. */
export function keysetArgs(request: PageRequest): {
  readonly where: { readonly id?: { readonly gt: string } };
  readonly orderBy: { readonly id: "asc" };
  readonly take: number;
} {
  return {
    where: request.after === undefined ? {} : { id: { gt: request.after } },
    orderBy: { id: "asc" },
    take: request.limit + 1,
  };
}

export function toPage<Row, Item>(
  rows: readonly Row[],
  request: PageRequest,
  idOf: (row: Row) => string,
  map: (row: Row) => Item,
): Page<Item> {
  const selected = rows.slice(0, request.limit);
  const last = selected.at(-1);
  return {
    items: selected.map(map),
    nextCursor: rows.length > request.limit && last !== undefined ? idOf(last) : null,
  };
}
