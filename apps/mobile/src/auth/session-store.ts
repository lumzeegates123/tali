import type {
  BusinessResponse,
  CreateBusinessRequest,
  CurrentUserResponse,
  LocationResponse,
  MembersResponse,
  MyBusinessesResponse,
} from "@tali/shared";
import { AcceptInvitationRequestSchema, CreateBusinessRequestSchema } from "@tali/shared";
import type {
  AccessToken,
  ApiFailure,
  ApiResult,
  DeviceHeaders,
  PageRequest,
  TaliApiClient,
} from "../api/tali-api-client";
import {
  type DeviceCredentialStore,
  type DeviceRegistration,
  noDeviceCredentialStore,
} from "../devices/device-credential-store";
import { type AuthSession, staticAuthSession } from "./auth-session";

/**
 * Build 1 client session (plan 003 section 7): the current user, the loaded
 * businesses and the selected business live in this object's memory only.
 * Access tokens come from the auth session per call and are never kept here.
 * A Cognito auth session persists on its own (ADR-007, `tali.cognito.v1.*`);
 * a local development session does not. A device registration (Slice 5) is
 * kept per business in the device credential store (the platform keystore)
 * and survives sign-out and restarts. The Tali API stays
 * authoritative: the store never decides permissions, tenancy or idempotency
 * outcomes; it only reacts to the API's responses.
 */

/**
 * Device registration for the selected business, as the UI may show it.
 * `untrusted`: the API refused the stored registration; it has been removed
 * from this device and is never re-registered automatically.
 */
export type DeviceState =
  "unsupported" | "none" | "checking" | "unregistered" | "registered" | "untrusted" | "unavailable";

export type RegisterDeviceOutcome =
  | { readonly status: "registered" }
  /** A retry replayed a registration created earlier; its one-time credential cannot be received again. */
  | { readonly status: "credentialUnavailable" }
  | { readonly status: "storageFailed" }
  | { readonly status: "invalid" }
  | { readonly status: "ignored" }
  | { readonly status: "failed"; readonly failure: ApiFailure };

export type AcceptInvitationOutcome =
  | { readonly status: "accepted"; readonly businessName: string }
  | { readonly status: "invalid" }
  | { readonly status: "ignored" }
  | { readonly status: "failed"; readonly failure: ApiFailure };

/** Device labels follow the API rule: 1 to 60 characters after trimming. */
export const DEVICE_LABEL_MAX = 60;

export type SessionPhase =
  | "signedOut"
  | "signingIn"
  | "needsRegistration"
  | "loadingBusinesses"
  | "choosingBusiness"
  | "businessSelected"
  | "error";

export type SessionAction = "signIn" | "checkUser" | "register" | "loadBusinesses" | "createBusiness";

export type BusinessSummary = MyBusinessesResponse["items"][number];

/** Why the session ended or the selection was cleared; wording is generic by design. */
export type SessionNotice = "signedOut" | "sessionEnded" | "businessUnavailable" | "invitationAccepted";

export interface SessionError {
  readonly action: SessionAction;
  readonly failure: ApiFailure;
}

/** Everything the UI may render. It never contains the access token or an idempotency key. */
export interface SessionSnapshot {
  readonly phase: SessionPhase;
  readonly user: CurrentUserResponse | undefined;
  readonly businesses: readonly BusinessSummary[];
  readonly businessesNextCursor: string | null;
  readonly selectedBusinessId: string | undefined;
  readonly pending: SessionAction | "loadMoreBusinesses" | "registerDevice" | "acceptInvitation" | undefined;
  readonly error: SessionError | undefined;
  readonly notice: SessionNotice | undefined;
  /** Never contains the device ID or credential. */
  readonly device: DeviceState;
}

export type CreateBusinessOutcome =
  | { readonly status: "created"; readonly businessId: string }
  | { readonly status: "ignored" }
  | { readonly status: "invalid"; readonly fields: readonly string[] }
  | { readonly status: "failed"; readonly failure: ApiFailure };

export interface BusinessOverview {
  readonly business: BusinessResponse;
  readonly defaultLocation: LocationResponse;
}

/** A read for the selected business, after the store has applied session effects (401, 404). */
export type ResourceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ApiFailure | { readonly kind: "missing-default-location" } };

/**
 * How a business-scoped request reads NOT_FOUND. `business`: a business-level
 * read (lists, units, currency), where NOT_FOUND means the business itself is
 * unavailable. `resource`: one record or a mutation, where NOT_FOUND says
 * nothing about the business.
 */
export interface BusinessRequestPolicy {
  readonly notFoundScope: "business" | "resource";
}

/** The session and business selection a request began under. */
interface Selection {
  readonly epoch: number;
  readonly revision: number;
  readonly businessId: string;
}

/**
 * Passed to one request callback and valid for that request only; never kept
 * by the caller. `device` is present only when this device holds a
 * registration for the same business.
 */
export interface BusinessRequestCredentials {
  readonly token: AccessToken;
  readonly device: DeviceHeaders | undefined;
}

export type BusinessRequestResult<T> =
  | ApiResult<T>
  /** The session or selected business changed, or the session itself handled the failure. */
  | { readonly status: "ignored" }
  | { readonly status: "businessUnavailable"; readonly failure: ApiFailure };

export interface SessionStoreOptions {
  readonly api: TaliApiClient;
  /** The approved client UUID implementation (RFC 9562 UUIDv7), used for Idempotency-Key values. */
  readonly newIdempotencyKey: () => string;
  /** Android only in Build 1; elsewhere device registration is not offered and nothing is stored. */
  readonly deviceRegistrationSupported?: boolean;
  readonly deviceStore?: DeviceCredentialStore;
}

const BUSINESS_PAGE_SIZE = 50;
const LOCATION_PAGE_SIZE = 100;
const MAX_LOCATION_PAGES = 10;

const SIGNED_OUT: SessionSnapshot = Object.freeze({
  phase: "signedOut",
  user: undefined,
  businesses: [],
  businessesNextCursor: null,
  selectedBusinessId: undefined,
  pending: undefined,
  error: undefined,
  notice: undefined,
  device: "none",
});

interface CreateAttempt {
  readonly command: CreateBusinessRequest;
  readonly key: string;
}

interface RegisterAttempt {
  readonly businessId: string;
  readonly label: string;
  readonly key: string;
}

/** The registration of the selected business, in memory while it is selected. */
interface LoadedDevice {
  readonly businessId: string;
  readonly registration: DeviceRegistration;
}

/**
 * Accepts a pasted invitation link (`.../invitations/accept#token=...`) or
 * the token alone. Returns undefined for anything else.
 */
export function parseInvitationInput(input: string): string | undefined {
  const trimmed = input.trim();
  const marker = trimmed.indexOf("#token=");
  let token = marker === -1 ? trimmed : (trimmed.slice(marker + "#token=".length).split("&")[0] ?? "");
  try {
    token = decodeURIComponent(token);
  } catch {
    return undefined;
  }
  if (token === "" || /\s|[/?#]/u.test(token)) return undefined;
  return AcceptInvitationRequestSchema.safeParse({ token }).success ? token : undefined;
}

function isApiError(failure: ApiFailure, code: string): boolean {
  return failure.kind === "api-error" && failure.code === code;
}

/** A session that can no longer produce an access token is handled exactly like a 401 from the API. */
const SESSION_ENDED: { readonly ok: false; readonly failure: ApiFailure } = Object.freeze({
  ok: false,
  failure: Object.freeze({
    kind: "api-error",
    status: 401,
    code: "UNAUTHENTICATED",
    message: "Session ended",
    correlationId: undefined,
    fields: Object.freeze([]),
  }),
});
const PROVIDER_UNAVAILABLE: { readonly ok: false; readonly failure: ApiFailure } = Object.freeze({
  ok: false,
  failure: Object.freeze({ kind: "unavailable", reason: "network" }),
});
const IGNORED: { readonly status: "ignored" } = Object.freeze({ status: "ignored" });

function sameCommand(left: CreateBusinessRequest, right: CreateBusinessRequest): boolean {
  return left.name === right.name && left.currencyCode === right.currencyCode && left.timeZone === right.timeZone;
}

export class SessionStore {
  readonly #api: TaliApiClient;
  readonly #newIdempotencyKey: () => string;
  readonly #listeners = new Set<() => void>();
  #snapshot: SessionSnapshot = SIGNED_OUT;
  #auth: AuthSession | undefined;
  /** Incremented whenever the session is replaced or cleared; late responses from an older session are dropped. */
  #epoch = 0;
  /** Advances whenever the selected business changes; the session epoch does not. */
  #selectionRevision = 0;
  #createAttempt: CreateAttempt | undefined;
  #createInFlight = false;
  readonly #deviceSupported: boolean;
  readonly #deviceStore: DeviceCredentialStore;
  #device: LoadedDevice | undefined;
  #deviceLoad: Promise<void> | undefined;
  #registerAttempt: RegisterAttempt | undefined;

  constructor(options: SessionStoreOptions) {
    this.#api = options.api;
    this.#newIdempotencyKey = options.newIdempotencyKey;
    this.#deviceSupported = options.deviceRegistrationSupported === true;
    this.#deviceStore = this.#deviceSupported
      ? (options.deviceStore ?? noDeviceCredentialStore)
      : noDeviceCredentialStore;
    this.#snapshot = this.#withDevice(SIGNED_OUT);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SessionSnapshot => this.#snapshot;

  /** Local development sign-in, then `GET /v1/me` to learn whether the identity is registered. */
  async signInLocal(subject: string): Promise<void> {
    if (this.#snapshot.phase !== "signedOut" || this.#snapshot.pending !== undefined) return;
    const epoch = this.#reset();
    this.#set({ ...SIGNED_OUT, phase: "signingIn", pending: "signIn" });
    const result = await this.#api.localSignIn(subject);
    if (epoch !== this.#epoch) return;
    if (!result.ok) {
      this.#set({ ...SIGNED_OUT, error: { action: "signIn", failure: result.failure } });
      return;
    }
    this.#auth = staticAuthSession(result.value.accessToken as AccessToken);
    await this.#checkUser(epoch);
  }

  /**
   * Starts a session the identity provider has already authenticated (Cognito
   * SRP sign-in in this app's UI, or a session restored from this device),
   * then `GET /v1/me`. Ignored, and the given session ended, unless signed out.
   */
  async beginSession(auth: AuthSession): Promise<void> {
    if (this.#snapshot.phase !== "signedOut" || this.#snapshot.pending !== undefined) {
      void auth.end({ everywhere: false });
      return;
    }
    const epoch = this.#reset();
    this.#auth = auth;
    await this.#checkUser(epoch);
  }

  /** Repeats the step that failed (checking the user or loading businesses) with the same session. */
  async retry(): Promise<void> {
    const { phase, error } = this.#snapshot;
    if (phase !== "error" || error === undefined || this.#auth === undefined) return;
    if (error.action === "checkUser") await this.#checkUser(this.#epoch);
    if (error.action === "loadBusinesses") await this.#loadBusinesses(this.#epoch, undefined);
  }

  async register(displayName: string): Promise<void> {
    if (
      this.#auth === undefined ||
      this.#snapshot.phase !== "needsRegistration" ||
      this.#snapshot.pending !== undefined
    ) {
      return;
    }
    const epoch = this.#epoch;
    this.#patch({ pending: "register", error: undefined });
    const result = await this.#withToken((token) => this.#api.registerCurrentUser(token, displayName));
    if (epoch !== this.#epoch) return;
    if (!result.ok) {
      if (this.#applySessionEffects(result.failure)) return;
      this.#patch({ pending: undefined, error: { action: "register", failure: result.failure } });
      return;
    }
    this.#patch({ user: result.value, pending: undefined });
    await this.#loadBusinesses(epoch, undefined);
  }

  async loadMoreBusinesses(): Promise<void> {
    const { phase, businessesNextCursor, pending } = this.#snapshot;
    if (
      this.#auth === undefined ||
      phase !== "choosingBusiness" ||
      businessesNextCursor === null ||
      pending !== undefined
    ) {
      return;
    }
    const epoch = this.#epoch;
    this.#patch({ pending: "loadMoreBusinesses", error: undefined });
    const result = await this.#withToken((token) =>
      this.#api.listMyBusinesses(token, { limit: BUSINESS_PAGE_SIZE, after: businessesNextCursor }),
    );
    if (epoch !== this.#epoch) return;
    if (!result.ok) {
      if (this.#applySessionEffects(result.failure)) return;
      this.#patch({ pending: undefined, error: { action: "loadBusinesses", failure: result.failure } });
      return;
    }
    this.#patch({
      pending: undefined,
      businesses: [...this.#snapshot.businesses, ...result.value.items],
      businessesNextCursor: result.value.nextCursor,
    });
  }

  /** Selects one of the businesses the API returned; any other ID is ignored. */
  selectBusiness(businessId: string): void {
    if (this.#auth === undefined) return;
    if (!this.#snapshot.businesses.some((item) => item.business.id === businessId)) return;
    this.#patch({ phase: "businessSelected", selectedBusinessId: businessId, error: undefined, notice: undefined });
    if (this.#deviceSupported) this.#deviceLoad = this.#loadDevice(this.#epoch, businessId);
  }

  /** Returns to the business picker; the selection is cleared, never remembered. */
  changeBusiness(): void {
    if (this.#snapshot.phase !== "businessSelected") return;
    this.#patch({ phase: "choosingBusiness", selectedBusinessId: undefined, error: undefined, notice: undefined });
  }

  /**
   * `POST /v1/businesses` with one Idempotency-Key per logical submission: an
   * unchanged command resubmitted after a failure (for example a network
   * error, whose outcome is unknown) reuses its key, so the server replays
   * instead of creating a second business. A changed command gets a new key.
   * A submission while another is in flight is ignored.
   */
  async createBusiness(input: CreateBusinessRequest): Promise<CreateBusinessOutcome> {
    if (this.#auth === undefined || this.#createInFlight || this.#snapshot.phase !== "choosingBusiness") {
      return { status: "ignored" };
    }
    const parsed = CreateBusinessRequestSchema.safeParse({
      name: input.name.trim(),
      currencyCode: input.currencyCode,
      timeZone: input.timeZone.trim(),
    });
    if (!parsed.success) {
      return {
        status: "invalid",
        fields: parsed.error.issues.map((issue) => String(issue.path.at(-1) ?? "")).filter((name) => name !== ""),
      };
    }
    const command = parsed.data;
    const previous = this.#createAttempt;
    const attempt =
      previous !== undefined && sameCommand(previous.command, command)
        ? previous
        : { command, key: this.#newIdempotencyKey() };
    this.#createAttempt = attempt;
    this.#createInFlight = true;
    const epoch = this.#epoch;
    this.#patch({ pending: "createBusiness", error: undefined });
    let result;
    try {
      result = await this.#withToken((token) => this.#api.createBusiness(token, attempt.command, attempt.key));
    } finally {
      this.#createInFlight = false;
    }
    if (epoch !== this.#epoch) return { status: "ignored" };
    if (!result.ok) {
      // The key was used with a different command; a later submission must not reuse it.
      if (isApiError(result.failure, "IDEMPOTENCY_KEY_REUSED")) this.#createAttempt = undefined;
      if (this.#applySessionEffects(result.failure)) return { status: "failed", failure: result.failure };
      this.#patch({ pending: undefined, error: { action: "createBusiness", failure: result.failure } });
      return { status: "failed", failure: result.failure };
    }
    this.#createAttempt = undefined;
    // A new business has no registration of this device yet.
    const created: BusinessSummary = {
      business: result.value.business,
      membership: { id: result.value.membership.id, role: result.value.membership.role },
    };
    const refreshed = await this.#withToken((token) =>
      this.#api.listMyBusinesses(token, { limit: BUSINESS_PAGE_SIZE }),
    );
    if (epoch !== this.#epoch) return { status: "ignored" };
    const base = refreshed.ok ? refreshed.value.items : this.#snapshot.businesses;
    const businesses = base.some((item) => item.business.id === created.business.id) ? base : [...base, created];
    this.#patch({
      phase: "businessSelected",
      pending: undefined,
      businesses,
      businessesNextCursor: refreshed.ok ? refreshed.value.nextCursor : this.#snapshot.businessesNextCursor,
      selectedBusinessId: created.business.id,
    });
    if (this.#deviceSupported) this.#deviceLoad = this.#loadDevice(epoch, created.business.id);
    return { status: "created", businessId: created.business.id };
  }

  /** `GET /v1/businesses/:id` and its active default location from `GET .../locations`. */
  async loadBusinessOverview(businessId: string): Promise<ResourceResult<BusinessOverview>> {
    return this.#businessRead(businessId, async (token, device) => {
      const business = await this.#api.getBusiness(token, businessId, device);
      if (!business.ok) return business;
      let after: string | undefined;
      for (let page = 0; page < MAX_LOCATION_PAGES; page += 1) {
        const locations = await this.#api.listLocations(
          token,
          businessId,
          { limit: LOCATION_PAGE_SIZE, ...(after === undefined ? {} : { after }) },
          device,
        );
        if (!locations.ok) return locations;
        const defaultLocation = locations.value.items.find((item) => item.isDefault && item.status === "ACTIVE");
        if (defaultLocation !== undefined) {
          return {
            ok: true,
            status: 200,
            value: { business: business.value, defaultLocation },
            correlationId: undefined,
          };
        }
        if (locations.value.nextCursor === null) break;
        after = locations.value.nextCursor;
      }
      return "missing-default-location";
    });
  }

  /** `GET /v1/businesses/:id/members`; PERMISSION_DENIED is returned to the caller, never treated as empty. */
  async loadMembers(businessId: string, page: PageRequest = {}): Promise<ResourceResult<MembersResponse>> {
    return this.#businessRead(businessId, (token, device) => this.#api.listMembers(token, businessId, page, device));
  }

  /**
   * One request for the selected business, with credentials for that request
   * only. Device headers are attached only for this device's registration
   * with the same business; DEVICE_NOT_TRUSTED forgets that registration and
   * is returned, so a retry runs without it. The result is `ignored` when the
   * session or the selection changed before or during the request, or when
   * the session handled the failure (401, unregistered, disabled). With
   * `notFoundScope: "business"`, NOT_FOUND answers `businessUnavailable`; the
   * selection is never changed here, only by the user. With `"resource"`,
   * NOT_FOUND is an ordinary failure.
   */
  async businessRequest<T>(
    businessId: string,
    policy: BusinessRequestPolicy,
    send: (api: TaliApiClient, credentials: BusinessRequestCredentials) => Promise<ApiResult<T>>,
  ): Promise<BusinessRequestResult<T>> {
    const auth = this.#auth;
    if (auth === undefined || this.#snapshot.selectedBusinessId !== businessId) return IGNORED;
    const selection = this.#selection(businessId);
    if (this.#deviceLoad !== undefined) await this.#deviceLoad;
    if (!this.#isSelected(selection)) return IGNORED;
    const current = await auth.accessToken();
    // Token acquisition may be slow: a request must never reach the API after a sign-out or a business switch.
    if (!this.#isSelected(selection)) return IGNORED;
    const device = this.#device?.businessId === businessId ? this.#device.registration : undefined;
    const result = current.ok
      ? await send(this.#api, { token: current.token, device })
      : current.reason === "ended"
        ? SESSION_ENDED
        : PROVIDER_UNAVAILABLE;
    if (!this.#isSelected(selection)) return IGNORED;
    if (result.ok) return result;
    if (device !== undefined && isApiError(result.failure, "DEVICE_NOT_TRUSTED")) {
      await this.#forgetDevice(businessId, device);
      return result;
    }
    if (this.#applySessionEffects(result.failure)) return IGNORED;
    if (policy.notFoundScope === "business" && isApiError(result.failure, "NOT_FOUND")) {
      return { status: "businessUnavailable", failure: result.failure };
    }
    return result;
  }

  /**
   * `POST .../devices` for the selected business, Android only, when this
   * device holds no registration for it. One Idempotency-Key per logical
   * submission (business and label). The credential from the first response
   * is written to the device credential store before it is used; it is never
   * kept anywhere else.
   */
  async registerDevice(label: string): Promise<RegisterDeviceOutcome> {
    const businessId = this.#snapshot.selectedBusinessId;
    const { device, pending } = this.#snapshot;
    if (!this.#deviceSupported || this.#auth === undefined || businessId === undefined || pending !== undefined) {
      return { status: "ignored" };
    }
    if (device !== "unregistered" && device !== "untrusted") return { status: "ignored" };
    const trimmed = label.trim();
    if (trimmed.length < 1 || trimmed.length > DEVICE_LABEL_MAX) return { status: "invalid" };
    const previous = this.#registerAttempt;
    const attempt =
      previous !== undefined && previous.businessId === businessId && previous.label === trimmed
        ? previous
        : { businessId, label: trimmed, key: this.#newIdempotencyKey() };
    this.#registerAttempt = attempt;
    const epoch = this.#epoch;
    this.#patch({ pending: "registerDevice" });
    const result = await this.#withToken((token) =>
      this.#api.registerDevice(token, businessId, attempt.label, attempt.key),
    );
    if (epoch !== this.#epoch) return { status: "ignored" };
    if (!result.ok) {
      if (isApiError(result.failure, "IDEMPOTENCY_KEY_REUSED")) this.#registerAttempt = undefined;
      if (this.#applySessionEffects(result.failure)) return { status: "failed", failure: result.failure };
      this.#patch({ pending: undefined });
      return { status: "failed", failure: result.failure };
    }
    this.#registerAttempt = undefined;
    if (!result.value.credentialAvailable) {
      this.#patch({ pending: undefined });
      return { status: "credentialUnavailable" };
    }
    const registration = { deviceId: result.value.device.id, credential: result.value.credential };
    try {
      await this.#deviceStore.save(businessId, registration);
    } catch {
      if (epoch === this.#epoch) this.#patch({ pending: undefined });
      return { status: "storageFailed" };
    }
    if (epoch !== this.#epoch || this.#snapshot.selectedBusinessId !== businessId) return { status: "ignored" };
    this.#device = { businessId, registration };
    this.#patch({ pending: undefined, device: "registered" });
    return { status: "registered" };
  }

  /**
   * `POST /v1/invitations/accept` with a pasted link or token, once the user
   * is registered. On success the business list is reloaded so the new
   * business appears in the picker. The token is not kept after the call.
   */
  async acceptInvitation(input: string): Promise<AcceptInvitationOutcome> {
    const { phase, pending } = this.#snapshot;
    if (this.#auth === undefined || pending !== undefined) return { status: "ignored" };
    if (phase !== "choosingBusiness" && phase !== "businessSelected") return { status: "ignored" };
    const invitationToken = parseInvitationInput(input);
    if (invitationToken === undefined) return { status: "invalid" };
    const epoch = this.#epoch;
    this.#patch({ pending: "acceptInvitation", error: undefined, notice: undefined });
    const result = await this.#withToken((token) => this.#api.acceptInvitation(token, invitationToken));
    if (epoch !== this.#epoch) return { status: "ignored" };
    if (!result.ok) {
      if (this.#applySessionEffects(result.failure)) return { status: "failed", failure: result.failure };
      this.#patch({ pending: undefined });
      return { status: "failed", failure: result.failure };
    }
    this.#patch({ pending: undefined });
    await this.#loadBusinesses(epoch, "invitationAccepted");
    return { status: "accepted", businessName: result.value.business.name };
  }

  /**
   * Clears the auth session, user, businesses, selection and any pending
   * idempotency key. The auth session revokes its refresh token (or signs out
   * on all devices when `everywhere`) and clears its stored state without
   * blocking this call. Device registrations stay in the device credential
   * store: they belong to the device and business, and are used again only
   * after a member of that business signs in.
   */
  signOut(options: { readonly everywhere: boolean } = { everywhere: false }): void {
    this.#reset(options);
    this.#set({ ...SIGNED_OUT, notice: "signedOut" });
  }

  /** Runs one API call with a current access token; the token is never kept by the store. */
  async #withToken<T>(call: (token: AccessToken) => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    const auth = this.#auth;
    if (auth === undefined) return SESSION_ENDED;
    const current = await auth.accessToken();
    if (!current.ok) return current.reason === "ended" ? SESSION_ENDED : PROVIDER_UNAVAILABLE;
    return call(current.token);
  }

  #selection(businessId: string): Selection {
    return { epoch: this.#epoch, revision: this.#selectionRevision, businessId };
  }

  /** Leaving a business and selecting it again is a new selection: requests from the old one never send. */
  #isSelected(selection: Selection): boolean {
    return (
      selection.epoch === this.#epoch &&
      selection.revision === this.#selectionRevision &&
      this.#snapshot.selectedBusinessId === selection.businessId
    );
  }

  async #loadDevice(epoch: number, businessId: string): Promise<void> {
    this.#device = undefined;
    this.#patch({ device: "checking" });
    let registration: DeviceRegistration | undefined;
    try {
      registration = await this.#deviceStore.read(businessId);
    } catch {
      if (epoch === this.#epoch && this.#snapshot.selectedBusinessId === businessId) {
        this.#patch({ device: "unavailable" });
      }
      return;
    }
    if (epoch !== this.#epoch || this.#snapshot.selectedBusinessId !== businessId) return;
    this.#device = registration === undefined ? undefined : { businessId, registration };
    this.#patch({ device: registration === undefined ? "unregistered" : "registered" });
  }

  /** Removes a registration the API refused. The user must register again deliberately. */
  async #forgetDevice(businessId: string, refused: DeviceRegistration): Promise<void> {
    if (this.#device?.businessId === businessId && this.#device.registration.deviceId === refused.deviceId) {
      this.#device = undefined;
      if (this.#snapshot.selectedBusinessId === businessId) this.#patch({ device: "untrusted" });
    }
    try {
      const stored = await this.#deviceStore.read(businessId);
      if (stored?.deviceId === refused.deviceId) await this.#deviceStore.clear(businessId);
    } catch {
      // The in-memory copy is already gone; a stored copy is refused again on next use.
    }
  }

  async #checkUser(epoch: number): Promise<void> {
    if (this.#auth === undefined) return;
    this.#set({ ...SIGNED_OUT, phase: "signingIn", pending: "checkUser" });
    const result = await this.#withToken((token) => this.#api.getCurrentUser(token));
    if (epoch !== this.#epoch) return;
    if (!result.ok) {
      if (this.#applySessionEffects(result.failure)) return;
      this.#set({ ...SIGNED_OUT, phase: "error", error: { action: "checkUser", failure: result.failure } });
      return;
    }
    this.#set({ ...SIGNED_OUT, phase: "loadingBusinesses", user: result.value });
    await this.#loadBusinesses(epoch, undefined);
  }

  async #loadBusinesses(epoch: number, notice: SessionNotice | undefined): Promise<void> {
    if (this.#auth === undefined) return;
    this.#patch({
      phase: "loadingBusinesses",
      pending: undefined,
      error: undefined,
      notice,
      businesses: [],
      businessesNextCursor: null,
      selectedBusinessId: undefined,
    });
    const result = await this.#withToken((token) => this.#api.listMyBusinesses(token, { limit: BUSINESS_PAGE_SIZE }));
    if (epoch !== this.#epoch) return;
    if (!result.ok) {
      if (this.#applySessionEffects(result.failure)) return;
      this.#patch({ phase: "error", error: { action: "loadBusinesses", failure: result.failure } });
      return;
    }
    this.#patch({
      phase: "choosingBusiness",
      businesses: result.value.items,
      businessesNextCursor: result.value.nextCursor,
    });
  }

  /**
   * A read scoped to one business. Device headers are attached only when this
   * device holds a registration for that same business; any other business
   * gets none.
   */
  async #businessRead<T>(
    businessId: string,
    read: (token: AccessToken, device: DeviceHeaders | undefined) => Promise<ApiResult<T> | "missing-default-location">,
  ): Promise<ResourceResult<T>> {
    const auth = this.#auth;
    if (auth === undefined) return { ok: false, failure: { kind: "unavailable", reason: "network" } };
    const epoch = this.#epoch;
    if (this.#deviceLoad !== undefined) await this.#deviceLoad;
    if (epoch !== this.#epoch) return { ok: false, failure: { kind: "unavailable", reason: "network" } };
    const device = this.#device?.businessId === businessId ? this.#device.registration : undefined;
    const current = await auth.accessToken();
    const result = current.ok
      ? await read(current.token, device)
      : current.reason === "ended"
        ? SESSION_ENDED
        : PROVIDER_UNAVAILABLE;
    if (result === "missing-default-location") return { ok: false, failure: { kind: result } };
    if (result.ok) return { ok: true, value: result.value };
    if (device !== undefined && isApiError(result.failure, "DEVICE_NOT_TRUSTED")) {
      await this.#forgetDevice(businessId, device);
      return { ok: false, failure: result.failure };
    }
    if (epoch === this.#epoch && !this.#applySessionEffects(result.failure)) {
      if (isApiError(result.failure, "NOT_FOUND") && this.#snapshot.selectedBusinessId === businessId) {
        // Tenant hiding: the reason is never known here and never guessed.
        void this.#loadBusinesses(epoch, "businessUnavailable");
      }
    }
    return { ok: false, failure: result.failure };
  }

  /**
   * Applies what an API failure says about the session itself. Only
   * authentication and account codes change it; PERMISSION_DENIED and
   * NOT_FOUND say nothing about the token. Returns true when handled.
   */
  #applySessionEffects(failure: ApiFailure): boolean {
    if (isApiError(failure, "UNAUTHENTICATED")) {
      this.#reset();
      this.#set({ ...SIGNED_OUT, notice: "sessionEnded" });
      return true;
    }
    if (isApiError(failure, "USER_NOT_REGISTERED")) {
      this.#createAttempt = undefined;
      this.#set({ ...SIGNED_OUT, phase: "needsRegistration" });
      return true;
    }
    if (isApiError(failure, "USER_DISABLED")) {
      // The account cannot use Tali: the token is dropped and only signing out remains.
      this.#reset();
      this.#set({ ...SIGNED_OUT, phase: "error", error: { action: "checkUser", failure } });
      return true;
    }
    return false;
  }

  /** Ends any current auth session (revocation is best-effort and never awaited) and invalidates late responses. */
  #reset(options: { readonly everywhere: boolean } = { everywhere: false }): number {
    const ended = this.#auth;
    this.#auth = undefined;
    if (ended !== undefined) void ended.end(options);
    this.#createAttempt = undefined;
    this.#createInFlight = false;
    this.#registerAttempt = undefined;
    this.#deviceLoad = undefined;
    this.#epoch += 1;
    return this.#epoch;
  }

  #patch(changes: Partial<SessionSnapshot>): void {
    this.#set({ ...this.#snapshot, ...changes });
  }

  /** Without a selected business there is no device state; the in-memory registration is dropped. */
  #withDevice(next: SessionSnapshot): SessionSnapshot {
    if (!this.#deviceSupported) return { ...next, device: "unsupported" };
    if (next.selectedBusinessId === undefined) {
      this.#device = undefined;
      this.#deviceLoad = undefined;
      return { ...next, device: "none" };
    }
    return next;
  }

  #set(next: SessionSnapshot): void {
    if (next.selectedBusinessId !== this.#snapshot.selectedBusinessId) this.#selectionRevision += 1;
    this.#snapshot = Object.freeze(this.#withDevice(next));
    for (const listener of this.#listeners) listener();
  }
}
