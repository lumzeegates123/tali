declare const objectKeyBrand: unique symbol;

/**
 * A storage key. Keys may include tenant prefixes for organization and
 * provenance, but a key prefix is never an authorization boundary: access is
 * decided by the application before any signed URL is issued (ADR-001).
 */
export type ObjectKey = string & { readonly [objectKeyBrand]: true };

const OBJECT_KEY_PATTERN = /^(?!\/)(?!.*\/\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9!_.*'()/-]{1,1024}$/;

export function isObjectKey(value: string): value is ObjectKey {
  return OBJECT_KEY_PATTERN.test(value);
}

export interface UploadTargetRequest {
  readonly key: ObjectKey;
  readonly contentType: string;
  readonly maxBytes: number;
  readonly expiresInSeconds: number;
}

/** A short-lived, single-object upload target handed to a client. */
export interface UploadTarget {
  readonly method: "PUT" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fields: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface DownloadUrlRequest {
  readonly key: ObjectKey;
  readonly expiresInSeconds: number;
}

export interface DownloadUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface StoredObjectInfo {
  readonly key: ObjectKey;
  readonly byteSize: number;
  readonly contentType: string;
}

export interface PutObjectRequest {
  readonly key: ObjectKey;
  readonly contentType: string;
  readonly body: Uint8Array;
}

/** Private object storage (S3 when deployed; local or in-memory otherwise). */
export interface ObjectStorageProvider {
  createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget>;
  createDownloadUrl(request: DownloadUrlRequest): Promise<DownloadUrl>;
  /** Returns null when the object does not exist. */
  getObjectInfo(key: ObjectKey): Promise<StoredObjectInfo | null>;
  /** Returns null when the object does not exist. */
  getObject(key: ObjectKey): Promise<Uint8Array | null>;
  putObject(request: PutObjectRequest): Promise<void>;
}
