import type { Id } from "@tali/domain";
import { parseId } from "@tali/domain";
import type { IdGenerator } from "../ports/id-generator";

const DEFAULT_BASE_EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * Deterministic UUIDv7-shaped identifiers for tests: the timestamp field is
 * `baseEpochMs + sequence` and the random fields hold the sequence number, so
 * values are valid UUIDv7, unique and strictly increasing. Never use outside
 * tests: the "random" bits are predictable.
 */
export class SequentialIdGenerator implements IdGenerator {
  readonly issued: { entity: string; id: string }[] = [];
  readonly #baseEpochMs: number;
  #sequence = 0;

  constructor(baseEpochMs: number = DEFAULT_BASE_EPOCH_MS) {
    this.#baseEpochMs = baseEpochMs;
  }

  newId<Entity extends string>(entity: Entity): Id<Entity> {
    this.#sequence += 1;
    const timestamp = (this.#baseEpochMs + this.#sequence).toString(16).padStart(12, "0");
    const counter = this.#sequence.toString(16).padStart(12, "0");
    const raw = `${timestamp.slice(0, 8)}-${timestamp.slice(8, 12)}-7000-8000-${counter}`;
    const id = parseId(entity, raw);
    this.issued.push({ entity, id });
    return id;
  }
}
