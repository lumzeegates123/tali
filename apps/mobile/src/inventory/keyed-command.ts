import type { ApiFailure } from "../api/tali-api-client";

/**
 * One Idempotency-Key per logical stock submission, in memory only. After an
 * outcome Tali could not confirm (network failure, timeout, unreadable
 * response, server error, a request still in progress) the submission stays
 * *unconfirmed*: only the identical command may be sent again, and it reuses
 * the key, so the server replays instead of moving stock twice. A different
 * command is refused until the person explicitly discards the unconfirmed
 * submission. A confirmed success or a definite rejection ends the attempt.
 */
export class KeyedCommand<C> {
  readonly #newKey: () => string;
  #attempt: { readonly command: C; readonly key: string } | undefined;
  #unconfirmed = false;
  #inFlight = false;

  constructor(newKey: () => string) {
    this.#newKey = newKey;
  }

  get inFlight(): boolean {
    return this.#inFlight;
  }

  /** True after an unknown outcome until the same command succeeds, is rejected, or is discarded. */
  get unconfirmed(): boolean {
    return this.#unconfirmed;
  }

  /** The key for this command, `"busy"` while one is in flight, or `"differs"` while another is unconfirmed. */
  begin(command: C): { readonly key: string } | "busy" | "differs" {
    if (this.#inFlight) return "busy";
    const previous = this.#attempt;
    if (this.#unconfirmed && previous !== undefined && !sameCommand(previous.command, command)) return "differs";
    const attempt =
      previous !== undefined && sameCommand(previous.command, command) ? previous : { command, key: this.#newKey() };
    this.#attempt = attempt;
    this.#inFlight = true;
    return { key: attempt.key };
  }

  /** Ends the in-flight submission with its API outcome; `undefined` means it succeeded. */
  finish(failure: ApiFailure | undefined): void {
    this.#inFlight = false;
    if (failure !== undefined && isUnknownOutcome(failure)) {
      this.#unconfirmed = true;
      return;
    }
    this.#attempt = undefined;
    this.#unconfirmed = false;
  }

  /** The person chose to discard the unconfirmed submission; the next command gets a new key. */
  discard(): void {
    if (this.#inFlight) return;
    this.#attempt = undefined;
    this.#unconfirmed = false;
  }

  reset(): void {
    this.#attempt = undefined;
    this.#unconfirmed = false;
    this.#inFlight = false;
  }
}

/** Whether the server may have applied the request although no confirmed answer arrived. */
export function isUnknownOutcome(failure: ApiFailure): boolean {
  switch (failure.kind) {
    case "unavailable":
    case "invalid-response":
      return true;
    case "api-error":
      return failure.status >= 500 || failure.code === "IDEMPOTENCY_IN_PROGRESS";
  }
}

/** Structural equality of plain request data: the same keys with the same values, arrays in order. */
export function sameCommand(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameCommand(value, right[index]))
    );
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord);
  return (
    leftKeys.length === Object.keys(rightRecord).length &&
    leftKeys.every((key) => Object.hasOwn(rightRecord, key) && sameCommand(leftRecord[key], rightRecord[key]))
  );
}
