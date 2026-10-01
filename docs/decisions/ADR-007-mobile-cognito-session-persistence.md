# ADR-007. Mobile Cognito session persistence

- Status: ACCEPTED (2026-09-30)
- Date: 2026-09-30
- Deciders: Tali maintainers (human approval given 2026-09-30; drafted by an AI agent, accepted by the human
  maintainer). Acceptance record in section 13.
- Decision: **Option B**, persist the complete Amplify-managed Cognito mobile session in Expo SecureStore through
  Amplify's public `KeyValueStorageInterface` (section 3).
- Supersedes: **only** the mobile Cognito persistence wording of ADR-003 section 14.4, quoted in section 4 (partial
  supersession; ADR-003 remains ACCEPTED and every other ADR-003 decision is unchanged)
- Related: ADR-003 sections 14.3 to 14.5 (accepted), ADR-005 section 15 (Device credential, accepted),
  `docs/plans/003-build-1-identity-tenancy.md` (Slice 6), `docs/audits/build-1-slice-6.md`

## 1. Context

ADR-003 section 14.4 approved, for the Android app:

| Token                     | Where held                                                  |
| ------------------------- | ----------------------------------------------------------- |
| Access token (15 minutes) | memory                                                      |
| ID token (15 minutes)     | not sent to the API                                         |
| Refresh token (7 days)    | `expo-secure-store` (Android Keystore), partitioned by user |

It also requires `USER_SRP_AUTH` for sign-in, refresh with **`GetTokensFromRefreshToken`** (rotation enabled,
`REFRESH_TOKEN_AUTH` not used), `RevokeToken` on sign-out and `GlobalSignOut` for "sign out on all devices". Slice 6
must not hand-roll SRP or the Cognito protocol. The Device credential (ADR-005 section 15) is stored separately and
never authenticates a user.

The only vetted client that meets the SRP and rotation requirements is **Amplify Auth v6**, through the public
`aws-amplify` package (6.22.1, which pins `@aws-amplify/auth` 6.21.1 and `@aws-amplify/core` 6.19.2).
`amazon-cognito-identity-js` refreshes with `REFRESH_TOKEN_AUTH` and is rejected. The web client uses `aws-amplify`
with an in-memory token store, which satisfies ADR-003 for the web. **This ADR concerns only mobile.**

## 2. Compatibility spike evidence

The Slice 6 spike exercised `aws-amplify` 6.22.1 through its public API against a synthetic Cognito endpoint (no
network, no AWS). It ran in the test runtime (Node and jsdom), **not yet on a device under React Native**. It
showed:

1. `USER_SRP_AUTH` sign-in works; the password is not sent.
2. Refresh uses `GetTokensFromRefreshToken`, replaces the rotated refresh token, and concurrent refreshes are
   single-flight. `REFRESH_TOKEN_AUTH` is never used.
3. `signOut()` revokes the refresh token with `RevokeToken`; `signOut({ global: true })` calls `GlobalSignOut`.
4. The documented extension point `cognitoUserPoolsTokenProvider.setKeyValueStorage(KeyValueStorageInterface)`
   (`setItem`, `getItem`, `removeItem`, `clear`) receives every token write.
5. After a successful sign-in Amplify writes, under its own key names: the **access token**, the **ID token**, the
   **refresh token**, a **clock-drift** value, the **last-authenticated username**, and **sign-in details including
   the login identifier (the user's email)**.
6. **A refresh token alone does not restore a session.** Simulating an app restart in which only the
   refresh-related entries survived, `fetchAuthSession()` returned no session and made no refresh attempt. Amplify
   only refreshes when it can load its complete stored token set.
7. Persisting only the ADR-003 subset would require filtering Amplify's writes by its **undocumented key names**: an
   internal format that may change without notice, and one that did not restore a usable session.
8. No other supported Cognito client was shown to meet all the requirements (section 9).

Memory-only mobile authentication is technically possible, but staff would have to sign in again after every app
restart or process death.

## 3. Decision

**Option B.** The mobile app persists the **complete Amplify-managed Cognito session** using Amplify's supported
public `KeyValueStorageInterface`, implemented by a Tali adapter backed by **Expo SecureStore**
(`expo-secure-store`):

```text
Amplify-managed Cognito session
  -> public KeyValueStorageInterface
  -> Tali Expo SecureStore adapter (opaque keys and values; section 5)
```

Production code must **not** inspect Amplify's internal key names, persist selectively based on undocumented key
names, use private `@aws-amplify/*` APIs, or fall back to AsyncStorage for Cognito session persistence.

Sections 5 to 9 and the implementation preconditions in section 11 are binding conditions of this decision.

## 4. Relationship to ADR-003

This ADR **partially supersedes ADR-003 section 14.4, mobile Cognito persistence wording only**. The superseded
wording is:

- in the token table, row "Access token", column "Where held": the words "mobile: memory" (the full cell reads "web:
  memory; mobile: memory"). The mobile access token is no longer memory-only; the web part is unchanged.
- in the token table, row "Refresh token, mobile", column "Where held": "`expo-secure-store` (Android Keystore),
  partitioned by user". SecureStore now holds the complete Amplify session (section 5), not the refresh token alone;
  "partitioned by user" is met as section 6 describes.

The ADR-003 ID-token row ("not sent to the API; the API accepts access tokens only") still holds: the ID token may be
stored on the device (section 5) but is never sent to Tali's API. The summary rows in ADR-003 section 2 (maintainer
direction, row 4) and section 34 (human decision table, "Cognito tokens"), "mobile refresh 7 days in SecureStore",
are read together with this ADR.

Unchanged: token lifetimes (access 15 minutes, ID 15 minutes, web refresh 12 hours, mobile refresh 7 days),
`USER_SRP_AUTH`, refresh-token rotation with the 10-second grace period, `GetTokensFromRefreshToken`, `RevokeToken`
and `GlobalSignOut`, the residual-validity analysis, shared-device rules (section 14.5), provisioning (section 14.6),
the app-client configuration, **web tokens memory-only**, and every infrastructure topology decision.

## 5. Persistence contract

### 5.1 Opaque keys and values

The mobile storage adapter treats **every Amplify key and value as opaque**. Every value Amplify writes through its
public `KeyValueStorageInterface` for the Cognito session is stored in the dedicated Cognito SecureStore namespace
(section 6). The adapter must **not**:

- parse Amplify key names or values;
- classify keys by undocumented naming;
- persist selectively based on internal key names;
- depend on private `@aws-amplify/*` packages or internal APIs.

Transforming a key mechanically so SecureStore accepts it (SecureStore keys allow only letters, digits, `.`, `-`
and `_`, while Amplify keys may contain other characters such as `@`) is permitted when the transformation is
content-blind, for example an encoding or digest of the whole key. How a logical Amplify entry is stored is defined
by the Tali-owned format in section 5.6.

### 5.2 What may be persisted

Persisted Amplify session state may include:

- access token;
- ID token;
- refresh token;
- clock-drift and session metadata;
- username / login identifier;
- the sign-in details Amplify requires.

**This ADR explicitly accepts this larger, encrypted-at-rest mobile session footprint** in place of the
refresh-token-only footprint of ADR-003 section 14.4.

### 5.3 What must never be persisted

- the password;
- any raw authentication request (for example SRP request bodies);
- AWS credentials of any kind (the app has none; ADR-001, `70-security.mdc`).

### 5.4 What must never be logged

- access token, ID token or refresh token;
- the password;
- Amplify session values or storage keys;
- the full email address or login identifier, unless strictly necessary (mask it otherwise).

### 5.5 Personal data classification

The email / login identifier and the ID-token claims stored in the session are **local encrypted personal data**.
They are used only by Amplify. Tali code does not read them from storage, and they are removed with the session
(section 7).

### 5.6 Storage format: manifests and chunks

Expo SecureStore does not guarantee support for arbitrarily large strings, and some iOS versions historically
rejected values around or above 2 KiB. Cognito tokens, especially ID tokens with claims and refresh tokens, can
approach or exceed that size. The adapter therefore **must not assume that one Amplify value fits in one SecureStore
value**. It implements a **content-blind chunking contract**:

```text
logical Amplify entry (opaque key, opaque value)
  -> Tali-safe storage identifier (content-blind encoding or digest of the whole key)
  -> versioned manifest
  -> one or more bounded SecureStore chunks
```

Requirements:

- **Opaque.** The adapter treats both the Amplify key and value as opaque. It does not interpret token or session
  content and does not match Amplify's internal key names (section 9).
- **Byte-bounded chunks.** Chunks are bounded by **UTF-8 byte length, not JavaScript character count**. A chunk
  boundary never splits a character's encoding, so every chunk is a valid string. The maximum chunk size is chosen
  conservatively during implementation, well below the historical 2 KiB limit, and recorded with the evidence for it.
- **Versioned, Tali-owned format.** The manifest records at least the format version, a write generation, the chunk
  count and the total UTF-8 byte length of the value. It may also hold an integrity check of the reconstructed value
  (for example a digest) if that needs no unreviewed dependency. An unknown format version is treated as absent.
- **Exact reconstruction.** A read reassembles the chunks and returns the value to Amplify exactly as written,
  string-for-string and byte-for-byte.
- **Fail closed.** A missing chunk, extra or mismatched chunk, length or integrity mismatch, or unreadable manifest
  makes the entry absent, so Amplify sees no session and the user signs in again. The adapter never returns a partial
  or guessed value.
- **Safe replacement.** A new value is written under a new generation: chunks first, then the manifest that points at
  them, then the previous generation's chunks are removed. Chunks left by an interrupted write or replacement, which
  no manifest references, are removed on the next write, read or clear of that entry, or of the whole namespace.
- **Complete clearing.** `removeItem` removes the entry's manifest and every chunk. `clear()`, logout and definitive
  refresh failure remove **every manifest, chunk and index entry in the Cognito namespace**.
- **Key index.** Because SecureStore cannot list its entries, the adapter keeps an index of the storage identifiers it
  has written. The index is **Tali-owned metadata** in the Cognito namespace; it holds storage identifiers only, never
  values.

## 6. SecureStore boundary

### 6.1 SecureStore is the only Cognito destination

**Expo SecureStore**, through Amplify's supported `KeyValueStorageInterface` and the adapter of section 5, is the only
place Cognito authentication or session data is persisted. If SecureStore is unavailable or a read or write fails,
the session is treated as ended (the user signs in again). The app never silently falls back to other storage and
never crashes.

### 6.2 AsyncStorage: package allowed, Cognito persistence forbidden

AWS's documented React Native Amplify setup installs `@react-native-async-storage/async-storage` as a compatibility
dependency. On React Native, Amplify's built-in default storage loads it at runtime (`@aws-amplify/core` 6.19.2,
`DefaultStorage.native`), although `@aws-amplify/react-native` 1.3.3 does not list it as a peer dependency. The
dependency review (section 11) records whether the pinned stack strictly requires it.

| Concern                                        | Rule                                                           |
| ---------------------------------------------- | -------------------------------------------------------------- |
| Package presence in `apps/mobile`              | **Allowed** if the supported Amplify React Native stack needs it |
| Cognito auth or session data persisted there   | **Forbidden**                                                  |
| AsyncStorage as a fallback for Cognito auth    | **Forbidden** in production code                               |

- No Cognito authentication or session value may be written to AsyncStorage: no access token, ID token, refresh
  token, login identifier, session metadata or other Amplify auth state.
- Tests must prove that **no such value is written to AsyncStorage** during sign-in, session restoration, refresh,
  refresh rotation, logout and global sign-out, for example by observing every AsyncStorage write in the test
  runtime and on the reference device.
- **If the installed Amplify runtime writes Cognito auth state to AsyncStorage even after the custom storage adapter
  is installed before auth initialization, implementation STOPS and the incompatibility is reported.** It is not
  worked around by filtering or deleting Amplify's AsyncStorage keys (section 9).

### 6.3 Storage installation order

- The Cognito SecureStore adapter is installed (`cognitoUserPoolsTokenProvider.setKeyValueStorage`), together with
  `Amplify.configure`, **before any Cognito authentication or session operation**: sign-in, sign-up,
  `fetchAuthSession`, `getCurrentUser`, refresh or sign-out.
- Amplify auth must never initialize or restore a session using its default AsyncStorage-backed persistence and then
  have its storage replaced afterward. Auth entry points are reachable only through the module that configures
  storage first.
- Implementation tests cover initialization order, for example: no auth call can run before configuration; the
  first storage read at app start goes to the SecureStore adapter; nothing reaches AsyncStorage before or after
  configuration.

### 6.4 Namespace separation

Two separate SecureStore namespaces, each owned by one module that never reads the other's entries:

| Namespace    | Contents                                                                                      | Cleared by                                             |
| ------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Cognito auth | Amplify-managed opaque session entries, stored as Tali manifests and chunks, plus the Tali key index (section 5.6) | user logout, definitive refresh failure, staff switch |
| Tali Device  | `deviceId` and device credential, per business (existing `tali.device.v1.` entries)           | the Device policy (ADR-005 section 15)                 |

- **User logout clears the Cognito namespace only.** It does not clear the Tali Device registration.
- **Device revocation clears the Device namespace according to the Device policy, not Cognito auth**, unless an
  independent authentication rule requires logout. What device revocation does to other local data stays an open
  decision (plan 003, open decision 15).
- **One active staff session per device** (ADR-003 section 14.5). The Cognito namespace holds at most one user's
  session. This is how the ADR-003 requirement "partitioned by user" is met: the previous session is fully cleared
  before the next person signs in.

## 7. Session lifecycle

### 7.1 Token semantics

- Access token **15 minutes**, ID token **15 minutes**, mobile refresh session **7 days** (ADR-003).
- Persisting an access token in SecureStore **does not extend its server validity**. The API keeps verifying `exp`
  and applies its per-request checks: User status, Membership and Device status (ADR-005).
- Refresh-token rotation stays mandatory. Refresh uses `GetTokensFromRefreshToken` or its supported Amplify
  equivalent. `REFRESH_TOKEN_AUTH` stays forbidden.

### 7.2 Normal logout

1. Attempt `RevokeToken` where applicable (Amplify `signOut()`), or `GlobalSignOut` for "sign out on all devices".
2. Clear the Cognito session from SecureStore **whether or not the remote revoke succeeds**.
3. Clear the in-memory user and business session.
4. Keep the Tali Device registration.

### 7.3 Staff switching on a shared device

The previous staff member's Cognito session is cleared, both in memory and in SecureStore, **before** the next staff
member authenticates. If clearing fails, the next sign-in does not start until clearing succeeds. The business's
Device registration is kept, and the next staff member authenticates separately with their own Cognito identity.

### 7.4 Refresh failure

- A **definitive** refresh failure (refresh token expired, revoked or refused by Cognito) clears the Cognito
  in-memory auth state and the Cognito SecureStore namespace. It does **not** clear the Tali Device credential.
- A **transient** failure (no network, timeout) is not definitive: the session stays as it is, and the client
  reports "unavailable" and retries, as the web client does.
- Offline queued commands are governed by ADR-003 section 14.4 and the sync ADR; this ADR does not change them.

## 8. Platform storage

- **iOS** (`keychainAccessible`): use the strongest accessibility class compatible with normal app and background
  behaviour on the current Expo SDK. Credentials must be unavailable before the first unlock after boot, and only a
  `*_THIS_DEVICE_ONLY` class is allowed, so entries never migrate through backup or to another device. Prefer
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (as the Device credential uses). Use `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` only if
  implementation shows the session must be readable while the device is locked. `ALWAYS*` classes and classes
  without `THIS_DEVICE_ONLY` are not allowed.
- **iOS Keychain residual behaviour.** Expo SecureStore stores values in the iOS Keychain. Keychain items **may survive
  an app uninstall and reinstall**. `THIS_DEVICE_ONLY` prevents migration to another device or through backup, but
  does **not by itself guarantee deletion on uninstall**. A reinstalled app could therefore find a previous Cognito
  session (still bounded by the 7-day refresh session, revocation and Tali's per-request checks). This is an
  explicit **residual privacy consideration**. How it is handled (for example, clearing the Cognito namespace on
  the first launch after install) is decided and verified before iOS is declared production-ready.
- **Build 1 scope.** Android remains the acceptance target. The Cognito SecureStore implementation is still designed
  for iOS (accessibility class, chunking, namespaces), but **native iOS device behaviour must be verified on a real
  iOS device before iOS is declared production-ready**. A JavaScript export (`expo export --platform ios`) is not
  evidence of iOS or App Store production readiness.
- **Android:** values are encrypted with an Android Keystore key. Keep the existing backup exclusion
  (`configureAndroidBackup: true` in `apps/mobile/app.config.ts`).
- Cognito session material must not be intentionally synchronized through device backup or cloud restore. If
  restored entries cannot be decrypted, the session is treated as ended.
- The implementation must document the **exact Android and iOS SecureStore behaviour it verified** on the
  reference device: accessibility class, backup exclusion, the chosen chunk size and the largest value stored, and
  behaviour after a lock-screen change or Keystore invalidation. Value size is handled by the chunking contract
  (section 5.6), never by interpreting values.

## 9. Permanent design rule: no key-name coupling

**Tali code must not contain logic that matches Amplify's internal session-key names.** Production code treats keys
and values as opaque data supplied through the supported storage interface. Tests may inspect observable storage
behaviour (for example, that the namespace is empty after logout, or that no token appears outside SecureStore), but
must not make production code depend on key names. Implementation adds a lint or test guard for this rule. The same
rule already holds on the web (`docs/audits/build-1-slice-6.md`).

## 10. Options considered

### A. Memory-only mobile session (rejected)

Tokens live in memory on mobile too. **Rejected:** staff would have to sign in after every app restart, process
death (common on low-memory Android devices) or update. That is poor for merchants and on shared devices, and it
contradicts ADR-003's approved 7-day mobile refresh.

### B. Complete Amplify session in SecureStore through the public interface (accepted)

Sections 3 to 9.

### C. Another Cognito client (deferred)

**Deferred:** no supported alternative has been shown to satisfy `USER_SRP_AUTH`, refresh-token rotation through
`GetTokensFromRefreshToken`, React Native support and revocation, together with the other accepted requirements,
without hand-written protocol code. Ruled out within this option: Amplify internal packages or internals,
`amazon-cognito-identity-js` (`REFRESH_TOKEN_AUTH`), and hand-written SRP or Cognito protocol code (ADR-003 section
14.3). A future candidate needs its own dependency review, spike and ADR.

## 11. Implementation preconditions

These are verified in the implementation step. They do not change the decision; if one cannot be met, the
implementation stops and reports.

1. **React Native dependency review.** Review the supported React Native Amplify dependencies **actually required by
   the pinned stack** (`aws-amplify` 6.22.1). Candidates, to be confirmed against the pinned versions:

   | Package                                     | Expected reason                                                                                      |
   | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
   | `@aws-amplify/react-native`                 | Amplify's documented React Native entry point (1.3.3 and Apache-2.0 at the time of writing); public, not an internal package |
   | `react-native-get-random-values`            | Peer of `@aws-amplify/react-native`; secure random values for SRP                                   |
   | `@react-native-async-storage/async-storage` | Compatibility dependency of the documented setup (section 6.2); must never hold Cognito data        |

   Any other package the pinned stack turns out to require is reviewed the same way. For each dependency, record:
   - the exact version (pinned exactly, like the rest of `apps/mobile`);
   - the license;
   - why it is required;
   - the native code it introduces;
   - Android and iOS implications (permissions, build configuration, backup behaviour);
   - whether it stores any Tali or Cognito data (for AsyncStorage the required answer is "no Cognito data").

   Optional peers such as `@aws-amplify/rtn-passkeys` are not added unless a feature needs them.
   **`@aws-amplify/ui-react-native` is not added**: Tali already has its own auth UI, and Amplify UI components are not
   required. Tali code imports only the public `aws-amplify` entry points.
2. **AsyncStorage and initialization order.** Tests prove the section 6.2 rule (no Cognito value written to
   AsyncStorage during sign-in, session restoration, refresh, refresh rotation, logout and global sign-out) and the
   section 6.3 initialization order. If Amplify writes Cognito auth state to AsyncStorage even with the adapter
   installed first, implementation stops and reports.
3. **Large-value adapter tests.** Before the mobile implementation is accepted, test the section 5.6 adapter with:
   - small values;
   - multibyte Unicode values;
   - values just below, at and just above the chosen chunk boundary;
   - values significantly larger than 2 KiB;
   - realistic synthetic access tokens;
   - realistic synthetic ID tokens with claims;
   - realistic synthetic refresh tokens.

   Every round trip must be byte-for-byte and string-for-string identical. The tests also cover missing, corrupt and
   extra chunks (fail closed), interrupted replacement (cleanup), unknown format versions, and `clear()` leaving the
   namespace empty. The storage behaviour is repeated on the **reference Android device**.
4. **No other persistent auth state.** Verify on device what Amplify does with its temporary sign-in workflow state on
   React Native (in the inspected source it falls back to in-memory storage when browser sessionStorage is absent).
   Verify that no Cognito material is written outside the Cognito SecureStore namespace.
5. **On-device evidence.** Repeat the section 2 evidence under React Native on the reference Android device: SRP,
   rotation, single-flight refresh, `RevokeToken`, `GlobalSignOut`, session restore after app restart, and complete
   clearing on logout and on definitive refresh failure.
6. **Device credential untouched.** Existing Device credential storage and its tests stay unchanged, and logout leaves
   it in place.
7. **iOS.** Not part of Build 1 acceptance. Before iOS is declared production-ready: verify on a real iOS device the
   accessibility class, chunking, and the uninstall and reinstall behaviour of section 8.

## 12. Consequences

- Staff stay signed in across app restarts for up to the 7-day refresh session, with rotation and revocation as
  ADR-003 requires.
- **Larger local footprint.** A compromised, unlocked device exposes a still-valid access token (at most 15
  minutes), the ID token and its claims, the refresh token and the email address, all encrypted at rest by the
  platform keystore. Tali's per-request checks (User status, Membership, Device status) and remote revocation
  (`GlobalSignOut`, user disable, device revoke) limit the impact.
- Email and ID-token claims become local encrypted personal data, removed with the session.
- On iOS, Keychain-backed session entries may survive uninstall and reinstall (section 8). This is a residual privacy
  consideration to resolve before iOS production readiness.
- `@react-native-async-storage/async-storage` may be present in the mobile app as an Amplify compatibility
  dependency, but it holds no Cognito data (section 6.2).
- Tali owns and versions a small storage format (manifests, chunks, index; section 5.6) that needs its own tests.
- Coupling to Amplify is limited to its public storage interface. No Tali code depends on Amplify's key names.
- The web is unaffected: Cognito tokens stay memory-only.
- **Status:** this ADR is ACCEPTED (section 13). Build 1 Slice 6 stays IN PROGRESS. The mobile Cognito client is
  unblocked but not started.

## 13. Acceptance record

- **Accepted 2026-09-30 by the human maintainer**, as written. The ADR was drafted with AI assistance; the AI agent did
  not accept it.
- **Option B is accepted** (sections 3 to 9 and 11). Option A stays rejected and Option C deferred (section 10).
- **Partial supersession.** This ADR supersedes only the mobile Cognito persistence wording of ADR-003 section 14.4
  (section 4). ADR-003 remains ACCEPTED and is otherwise unchanged; its text is not edited.
- **Deliberate expansion.** The approved mobile persistence footprint grows from the refresh token alone (ADR-003
  wording) to the Amplify-managed session material of section 5.2. Passwords and AWS credentials stay forbidden
  (section 5.3).
- **Unchanged:** ADR-003 token semantics (access 15 minutes, ID 15 minutes, mobile refresh 7 days, rotation enabled,
  `REFRESH_TOKEN_AUTH` forbidden, refresh through `GetTokensFromRefreshToken` or its supported Amplify equivalent),
  web Cognito tokens memory-only, and every infrastructure topology decision.
- **What acceptance unblocks:** implementation of the mobile Cognito client in Build 1 Slice 6, under the binding
  conditions and preconditions of this ADR.
- **What acceptance does not mean:**
  - no mobile Cognito code exists yet, and no implementation or acceptance test for it has passed;
  - **no package is approved by this acceptance**: the React Native Amplify dependencies (for example
    `@aws-amplify/react-native`, `react-native-get-random-values`, `@react-native-async-storage/async-storage`) still
    need the dependency review of section 11 (exact version, license, native impact), and
    `@aws-amplify/ui-react-native` is not added;
  - the AsyncStorage rule (section 6.2) is not yet proven: if Amplify writes Cognito auth data to AsyncStorage despite
    the adapter being configured first, implementation stops and reports;
  - iOS is not production-ready; its Keychain behaviour, including uninstall and reinstall, must be verified on a real
    device first (section 8);
  - Build 1 Slice 6 is not complete.
