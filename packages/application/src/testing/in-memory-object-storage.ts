import { ValidationError } from "../errors/application-error.js";
import type { Clock } from "../ports/clock.js";
import type {
  DownloadUrl,
  DownloadUrlRequest,
  ObjectKey,
  ObjectStorageProvider,
  PutObjectRequest,
  StoredObjectInfo,
  UploadTarget,
  UploadTargetRequest,
} from "../ports/object-storage-provider.js";
import { isObjectKey } from "../ports/object-storage-provider.js";

const MAX_SIGNED_URL_SECONDS = 3600;

interface StoredObject {
  readonly contentType: string;
  readonly body: Uint8Array;
}

interface PendingUpload {
  readonly contentType: string;
  readonly maxBytes: number;
  readonly expiresAtMs: number;
}

function assertKey(key: string): void {
  if (!isObjectKey(key)) {
    throw new ValidationError("invalid object key");
  }
}

function assertExpiry(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_SIGNED_URL_SECONDS) {
    throw new ValidationError(`signed URL lifetime must be 1-${MAX_SIGNED_URL_SECONDS} seconds`);
  }
}

/** Object storage held in memory, for tests and single-process smoke tests. */
export class InMemoryObjectStorage implements ObjectStorageProvider {
  readonly #clock: Clock;
  readonly #objects = new Map<string, StoredObject>();
  readonly #pendingUploads = new Map<string, PendingUpload>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget> {
    assertKey(request.key);
    assertExpiry(request.expiresInSeconds);
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) {
      throw new ValidationError("maxBytes must be a positive integer");
    }
    const expiresAt = new Date(this.#clock.now().getTime() + request.expiresInSeconds * 1000);
    this.#pendingUploads.set(request.key, {
      contentType: request.contentType,
      maxBytes: request.maxBytes,
      expiresAtMs: expiresAt.getTime(),
    });
    return {
      method: "PUT",
      url: `memory://objects/${encodeURIComponent(request.key)}?upload`,
      headers: { "content-type": request.contentType },
      fields: {},
      expiresAt,
    };
  }

  /** Test helper: simulates the client uploading to a previously issued target. */
  completeUpload(key: ObjectKey, body: Uint8Array): void {
    const pending = this.#pendingUploads.get(key);
    if (pending === undefined) throw new ValidationError("no upload target was issued for this key");
    if (this.#clock.now().getTime() > pending.expiresAtMs) throw new ValidationError("upload target expired");
    if (body.byteLength > pending.maxBytes) throw new ValidationError("upload exceeds the permitted size");
    this.#pendingUploads.delete(key);
    this.#objects.set(key, { contentType: pending.contentType, body: body.slice() });
  }

  async createDownloadUrl(request: DownloadUrlRequest): Promise<DownloadUrl> {
    assertKey(request.key);
    assertExpiry(request.expiresInSeconds);
    return {
      url: `memory://objects/${encodeURIComponent(request.key)}`,
      expiresAt: new Date(this.#clock.now().getTime() + request.expiresInSeconds * 1000),
    };
  }

  async getObjectInfo(key: ObjectKey): Promise<StoredObjectInfo | null> {
    assertKey(key);
    const stored = this.#objects.get(key);
    return stored === undefined ? null : { key, byteSize: stored.body.byteLength, contentType: stored.contentType };
  }

  async getObject(key: ObjectKey): Promise<Uint8Array | null> {
    assertKey(key);
    return this.#objects.get(key)?.body.slice() ?? null;
  }

  async putObject(request: PutObjectRequest): Promise<void> {
    assertKey(request.key);
    this.#objects.set(request.key, { contentType: request.contentType, body: request.body.slice() });
  }
}
