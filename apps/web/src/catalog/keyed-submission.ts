import type { AddPackRequest, CreateCategoryRequest, CreateProductRequest } from "@tali/shared";

/**
 * One Idempotency-Key per logical submission, in memory only. An unchanged
 * command resubmitted after a failure whose outcome is unknown (network,
 * timeout, server error) reuses its key, so the server replays instead of
 * creating twice. A changed command, a success or IDEMPOTENCY_KEY_REUSED
 * starts over with a new key. `sameCommand` is defined per operation from its
 * request fields; nothing is serialized or compared by property order.
 */
export class KeyedSubmission<C> {
  readonly #sameCommand: (left: C, right: C) => boolean;
  readonly #newKey: () => string;
  #attempt: { readonly command: C; readonly key: string } | undefined;
  #inFlight = false;

  constructor(sameCommand: (left: C, right: C) => boolean, newKey: () => string) {
    this.#sameCommand = sameCommand;
    this.#newKey = newKey;
  }

  get inFlight(): boolean {
    return this.#inFlight;
  }

  /** Starts a submission and returns its key; undefined while another submission is in flight. */
  begin(command: C): string | undefined {
    if (this.#inFlight) return undefined;
    const previous = this.#attempt;
    const attempt =
      previous !== undefined && this.#sameCommand(previous.command, command)
        ? previous
        : { command, key: this.#newKey() };
    this.#attempt = attempt;
    this.#inFlight = true;
    return attempt.key;
  }

  /** Ends the in-flight submission. `failed` keeps the key for a retry of the same command. */
  finish(outcome: "succeeded" | "keyReused" | "failed"): void {
    this.#inFlight = false;
    if (outcome !== "failed") this.#attempt = undefined;
  }

  /** Forgets any attempt, for example when the business changes or the store is disposed. */
  reset(): void {
    this.#attempt = undefined;
    this.#inFlight = false;
  }
}

function sameOptional<K extends string>(
  left: Partial<Record<K, string | undefined>>,
  right: Partial<Record<K, string | undefined>>,
  key: K,
): boolean {
  return key in left === key in right && left[key] === right[key];
}

export function sameCreateProduct(left: CreateProductRequest, right: CreateProductRequest): boolean {
  const leftPrice = left.initialPrice;
  const rightPrice = right.initialPrice;
  const samePrice =
    leftPrice === undefined || rightPrice === undefined
      ? leftPrice === rightPrice && "initialPrice" in left === "initialPrice" in right
      : leftPrice.amountMinor === rightPrice.amountMinor && leftPrice.currency === rightPrice.currency;
  return (
    left.name === right.name &&
    sameOptional(left, right, "description") &&
    sameOptional(left, right, "categoryId") &&
    sameOptional(left, right, "sku") &&
    sameOptional(left, right, "barcode") &&
    left.stockUnit === right.stockUnit &&
    left.trackInventory === right.trackInventory &&
    samePrice
  );
}

export function sameCreateCategory(left: CreateCategoryRequest, right: CreateCategoryRequest): boolean {
  return left.name === right.name;
}

/** AddPack is keyed per product: the same pack fields for another product are a different command. */
export interface AddPackCommand {
  readonly productId: string;
  readonly request: AddPackRequest;
}

export function sameAddPack(left: AddPackCommand, right: AddPackCommand): boolean {
  return (
    left.productId === right.productId &&
    left.request.name === right.request.name &&
    left.request.factorMinor === right.request.factorMinor
  );
}
