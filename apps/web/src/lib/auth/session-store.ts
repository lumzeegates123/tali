import type {
  BusinessResponse,
  CreateBusinessRequest,
  CurrentUserResponse,
  InvitationResponse,
  LocationResponse,
  MembersResponse,
  MyBusinessesResponse,
} from "@tali/shared";
import { CreateBusinessRequestSchema } from "@tali/shared";
import type {
  AccessToken,
  ApiFailure,
  ApiResult,
  InvitableRole,
  PageRequest,
  TaliApiClient,
} from "../api-client/tali-api-client";

/**
 * Build 1 client session (plan 003 section 7): the access token, the current
 * user, the loaded businesses and the selected business live in this object's
 * memory only. Nothing is written to any browser storage or cookie, so a
 * reload intentionally loses the session. The Tali API stays authoritative:
 * the store never decides permissions, tenancy or idempotency outcomes; it
 * only reacts to the API's responses.
 */

export type SessionPhase =
  | "signedOut"
  | "signingIn"
  | "needsRegistration"
  | "loadingBusinesses"
  | "choosingBusiness"
  | "businessSelected"
  | "error";

export type SessionAction =
  "signIn" | "checkUser" | "register" | "loadBusinesses" | "createBusiness" | "acceptInvitation";

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
  readonly pending: SessionAction | "loadMoreBusinesses" | undefined;
  readonly error: SessionError | undefined;
  readonly notice: SessionNotice | undefined;
  /** An invitation link was opened and its token is held in memory, waiting to be accepted. */
  readonly hasPendingInvitation: boolean;
}

export type CreateInvitationOutcome =
  | { readonly status: "created"; readonly invitation: InvitationResponse; readonly token: string }
  /** A retry replayed an invitation created earlier; its one-time token cannot be shown again. */
  | { readonly status: "alreadyShown"; readonly invitation: InvitationResponse }
  | { readonly status: "ignored" }
  | { readonly status: "failed"; readonly failure: ApiFailure };

export type RevokeInvitationOutcome =
  | { readonly status: "revoked"; readonly invitation: InvitationResponse }
  | { readonly status: "ignored" }
  | { readonly status: "failed"; readonly failure: ApiFailure };

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

export interface SessionStoreOptions {
  readonly api: TaliApiClient;
  /** The approved client UUID implementation (RFC 9562 UUIDv7), used for Idempotency-Key values. */
  readonly newIdempotencyKey: () => string;
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
  hasPendingInvitation: false,
});

interface CreateAttempt {
  readonly command: CreateBusinessRequest;
  readonly key: string;
}

interface InviteAttempt {
  readonly businessId: string;
  readonly role: InvitableRole;
  readonly key: string;
}

/** Accept failures after which the same token can never succeed; it is dropped from memory. */
const FINAL_ACCEPT_FAILURES = new Set(["NOT_FOUND", "CONFLICT", "VALIDATION_FAILED"]);

function isApiError(failure: ApiFailure, code: string): boolean {
  return failure.kind === "api-error" && failure.code === code;
}

function sameCommand(left: CreateBusinessRequest, right: CreateBusinessRequest): boolean {
  return left.name === right.name && left.currencyCode === right.currencyCode && left.timeZone === right.timeZone;
}

export class SessionStore {
  readonly #api: TaliApiClient;
  readonly #newIdempotencyKey: () => string;
  readonly #listeners = new Set<() => void>();
  #snapshot: SessionSnapshot = SIGNED_OUT;
  #token: AccessToken | undefined;
  /** Incremented whenever the session is replaced or cleared; late responses from an older session are dropped. */
  #epoch = 0;
  #createAttempt: CreateAttempt | undefined;
  #createInFlight = false;
  #inviteAttempt: InviteAttempt | undefined;
  #inviteInFlight = false;
  /** An invitation token from an opened link; memory only, never rendered, logged or stored. */
  #pendingInvitation: string | undefined;

  constructor(options: SessionStoreOptions) {
    this.#api = options.api;
    this.#newIdempotencyKey = options.newIdempotencyKey;
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
    this.#token = result.value.accessToken as AccessToken;
    await this.#checkUser(epoch);
  }

  /** Repeats the step that failed (checking the user or loading businesses) with the same session. */
  async retry(): Promise<void> {
    const { phase, error } = this.#snapshot;
    if (phase !== "error" || error === undefined || this.#token === undefined) return;
    if (error.action === "checkUser") await this.#checkUser(this.#epoch);
    if (error.action === "loadBusinesses") await this.#loadBusinesses(this.#epoch, undefined);
  }

  async register(displayName: string): Promise<void> {
    const token = this.#token;
    if (token === undefined || this.#snapshot.phase !== "needsRegistration" || this.#snapshot.pending !== undefined) {
      return;
    }
    const epoch = this.#epoch;
    this.#patch({ pending: "register", error: undefined });
    const result = await this.#api.registerCurrentUser(token, displayName);
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
    const token = this.#token;
    const { phase, businessesNextCursor, pending } = this.#snapshot;
    if (token === undefined || phase !== "choosingBusiness" || businessesNextCursor === null || pending !== undefined) {
      return;
    }
    const epoch = this.#epoch;
    this.#patch({ pending: "loadMoreBusinesses", error: undefined });
    const result = await this.#api.listMyBusinesses(token, { limit: BUSINESS_PAGE_SIZE, after: businessesNextCursor });
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
    if (this.#token === undefined) return;
    if (!this.#snapshot.businesses.some((item) => item.business.id === businessId)) return;
    this.#patch({ phase: "businessSelected", selectedBusinessId: businessId, error: undefined, notice: undefined });
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
    const token = this.#token;
    if (token === undefined || this.#createInFlight || this.#snapshot.phase !== "choosingBusiness") {
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
      result = await this.#api.createBusiness(token, attempt.command, attempt.key);
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
    const created: BusinessSummary = {
      business: result.value.business,
      membership: { id: result.value.membership.id, role: result.value.membership.role },
    };
    const refreshed = await this.#api.listMyBusinesses(token, { limit: BUSINESS_PAGE_SIZE });
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
    return { status: "created", businessId: created.business.id };
  }

  /** `GET /v1/businesses/:id` and its active default location from `GET .../locations`. */
  async loadBusinessOverview(businessId: string): Promise<ResourceResult<BusinessOverview>> {
    return this.#businessRead(businessId, async (token) => {
      const business = await this.#api.getBusiness(token, businessId);
      if (!business.ok) return business;
      let after: string | undefined;
      for (let page = 0; page < MAX_LOCATION_PAGES; page += 1) {
        const locations = await this.#api.listLocations(token, businessId, {
          limit: LOCATION_PAGE_SIZE,
          ...(after === undefined ? {} : { after }),
        });
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
    return this.#businessRead(businessId, (token) => this.#api.listMembers(token, businessId, page));
  }

  /**
   * `POST .../invitations` with one Idempotency-Key per logical submission
   * (business and role): retrying after a failure reuses the key, so the
   * server replays instead of creating a second invitation. A replay carries
   * no token, and the caller must say the link cannot be shown again.
   */
  async createInvitation(businessId: string, role: InvitableRole): Promise<CreateInvitationOutcome> {
    const token = this.#token;
    if (token === undefined || this.#inviteInFlight || this.#snapshot.selectedBusinessId !== businessId) {
      return { status: "ignored" };
    }
    const previous = this.#inviteAttempt;
    const attempt =
      previous !== undefined && previous.businessId === businessId && previous.role === role
        ? previous
        : { businessId, role, key: this.#newIdempotencyKey() };
    this.#inviteAttempt = attempt;
    this.#inviteInFlight = true;
    const epoch = this.#epoch;
    let result;
    try {
      result = await this.#api.createInvitation(token, businessId, role, attempt.key);
    } finally {
      this.#inviteInFlight = false;
    }
    if (epoch !== this.#epoch) return { status: "ignored" };
    if (!result.ok) {
      if (isApiError(result.failure, "IDEMPOTENCY_KEY_REUSED")) this.#inviteAttempt = undefined;
      this.#applySessionEffects(result.failure);
      return { status: "failed", failure: result.failure };
    }
    this.#inviteAttempt = undefined;
    return result.value.tokenAvailable
      ? { status: "created", invitation: result.value.invitation, token: result.value.token }
      : { status: "alreadyShown", invitation: result.value.invitation };
  }

  /** `POST .../invitations/:id/revoke`; revoking an already revoked invitation succeeds without change. */
  async revokeInvitation(businessId: string, invitationId: string): Promise<RevokeInvitationOutcome> {
    const token = this.#token;
    if (token === undefined || this.#snapshot.selectedBusinessId !== businessId) return { status: "ignored" };
    const epoch = this.#epoch;
    const result = await this.#api.revokeInvitation(token, businessId, invitationId);
    if (epoch !== this.#epoch) return { status: "ignored" };
    if (!result.ok) {
      this.#applySessionEffects(result.failure);
      return { status: "failed", failure: result.failure };
    }
    return { status: "revoked", invitation: result.value.invitation };
  }

  /**
   * Keeps the token from an opened invitation link in memory until the user
   * is signed in and accepts it. The first token wins; it is never rendered.
   */
  holdInvitation(invitationToken: string): void {
    if (this.#pendingInvitation !== undefined || invitationToken === "") return;
    this.#pendingInvitation = invitationToken;
    this.#patch({});
  }

  /** Forgets the held invitation token without accepting it. */
  discardInvitation(): void {
    this.#pendingInvitation = undefined;
    this.#patch({ error: this.#errorUnless("acceptInvitation") });
  }

  /**
   * `POST /v1/invitations/accept` with the held token, once the user is
   * registered. On success the business list is reloaded, so the new business
   * appears in the picker. A token that can never succeed (not found,
   * already a member, malformed) is dropped; a transport failure keeps it for
   * a retry, which the server answers idempotently for the same user.
   */
  async acceptInvitation(): Promise<void> {
    const token = this.#token;
    const invitationToken = this.#pendingInvitation;
    const { phase, pending } = this.#snapshot;
    if (token === undefined || invitationToken === undefined || pending !== undefined) return;
    if (phase !== "choosingBusiness" && phase !== "businessSelected") return;
    const epoch = this.#epoch;
    this.#patch({ pending: "acceptInvitation", error: undefined, notice: undefined });
    const result = await this.#api.acceptInvitation(token, invitationToken);
    if (epoch !== this.#epoch) return;
    if (!result.ok) {
      if (this.#applySessionEffects(result.failure)) return;
      if (result.failure.kind === "api-error" && FINAL_ACCEPT_FAILURES.has(result.failure.code)) {
        this.#pendingInvitation = undefined;
      }
      this.#patch({ pending: undefined, error: { action: "acceptInvitation", failure: result.failure } });
      return;
    }
    this.#pendingInvitation = undefined;
    this.#patch({ pending: undefined });
    await this.#loadBusinesses(epoch, "invitationAccepted");
  }

  /** Clears the token, user, businesses, selection, any held invitation and any pending idempotency key. */
  signOut(): void {
    this.#reset();
    this.#pendingInvitation = undefined;
    this.#set({ ...SIGNED_OUT, notice: "signedOut" });
  }

  #errorUnless(action: SessionAction): SessionError | undefined {
    return this.#snapshot.error?.action === action ? undefined : this.#snapshot.error;
  }

  async #checkUser(epoch: number): Promise<void> {
    const token = this.#token;
    if (token === undefined) return;
    this.#set({ ...SIGNED_OUT, phase: "signingIn", pending: "checkUser" });
    const result = await this.#api.getCurrentUser(token);
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
    const token = this.#token;
    if (token === undefined) return;
    this.#patch({
      phase: "loadingBusinesses",
      pending: undefined,
      error: undefined,
      notice,
      businesses: [],
      businessesNextCursor: null,
      selectedBusinessId: undefined,
    });
    const result = await this.#api.listMyBusinesses(token, { limit: BUSINESS_PAGE_SIZE });
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

  async #businessRead<T>(
    businessId: string,
    read: (token: AccessToken) => Promise<ApiResult<T> | "missing-default-location">,
  ): Promise<ResourceResult<T>> {
    const token = this.#token;
    if (token === undefined) return { ok: false, failure: { kind: "unavailable", reason: "network" } };
    const epoch = this.#epoch;
    const result = await read(token);
    if (result === "missing-default-location") return { ok: false, failure: { kind: result } };
    if (result.ok) return { ok: true, value: result.value };
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

  #reset(): number {
    this.#token = undefined;
    this.#createAttempt = undefined;
    this.#createInFlight = false;
    this.#inviteAttempt = undefined;
    this.#inviteInFlight = false;
    this.#epoch += 1;
    return this.#epoch;
  }

  #patch(changes: Partial<SessionSnapshot>): void {
    this.#set({ ...this.#snapshot, ...changes });
  }

  #set(next: SessionSnapshot): void {
    this.#snapshot = Object.freeze({ ...next, hasPendingInvitation: this.#pendingInvitation !== undefined });
    for (const listener of this.#listeners) listener();
  }
}
