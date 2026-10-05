import type { KeyValueStorageInterface } from "aws-amplify/utils";

/**
 * The Amplify token store for the web (ADR-003 section 14.4): access, ID and
 * refresh tokens live in this object's memory only, so a reload loses the
 * session. Keys are Amplify's own and are never parsed or relied on here.
 */
export class MemoryKeyValueStorage implements KeyValueStorageInterface {
  readonly #items = new Map<string, string>();

  async setItem(key: string, value: string): Promise<void> {
    this.#items.set(key, value);
  }

  async getItem(key: string): Promise<string | null> {
    return this.#items.get(key) ?? null;
  }

  async removeItem(key: string): Promise<void> {
    this.#items.delete(key);
  }

  async clear(): Promise<void> {
    this.#items.clear();
  }

  /** For tests: how many entries are held, without exposing them. */
  get size(): number {
    return this.#items.size;
  }
}
