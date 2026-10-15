# Build 2 Slice 8: hardening and final acceptance

- Date: 2026-10-10 (automated waves); 2026-10-11 (reference device walkthrough); 2026-10-14 to 2026-10-15 (final
  gates on the finished tree).
- Status: **COMPLETE** (all gates passed, including the reference Android device walkthrough; pending human review;
  nothing committed or pushed). Release readiness is not claimed.
- History: on 2026-10-10 this slice was recorded as BLOCKED ("Reference Android device walkthrough blocked: no
  reference device connected"). On 2026-10-11 the human maintainer performed the walkthrough on the physical
  reference device and it passed (section G); the final gates were then rerun on the finished tree (section H).
- Branch: `feature/build-2-slice-8-hardening-acceptance`, based on `ad538078c0f7e2b9913db14c6cd98484236ccf04`.
- Scope: Slice 8 of `docs/plans/004-build-2-catalog-inventory.md` under ADR-008 (ACCEPTED 2026-10-05, unchanged):
  audit-coverage review, bounded concurrency soak, tenancy/location/permission/device-trust/boundary review, web and
  Android low-stock acceptance, the reference device walkthrough, and the final gates. The Build 2 acceptance record
  is `docs/audits/build-2-final.md`.
- Change set against the base: 17 files (10 modified, 7 new, 0 deleted).
  - Production client code (2, modified): `apps/web/src/inventory/stocktake-detail.tsx`,
    `apps/mobile/src/inventory/stocktake-detail-screen.tsx` (defect D1 below).
  - Tests, test support and end-to-end (12: 7 modified, 5 new):
    - modified: `packages/database/test/support/tenancy.ts`; `apps/api/test/compat/business-route-guards.test.ts`;
      `apps/api/test/integration/catalog-api.integration.test.ts`, `inventory-api.integration.test.ts` and
      `stocktake-api.integration.test.ts`; `apps/web/test/inventory.test.tsx`; `apps/mobile/test/inventory.test.tsx`;
    - new: `packages/database/test/integration/zf-build2-audit-coverage.integration.test.ts` and
      `zg-inventory-concurrency-soak.integration.test.ts`; `apps/api/test/support/device-trust.ts` and
      `inventory-routes.ts`; `apps/web/e2e/low-stock.spec.ts`.
  - Documentation (3): this audit (new), `docs/audits/build-2-final.md` (new) and
    `docs/plans/004-build-2-catalog-inventory.md` (modified: Slice 8 and Build 2 status only).
- **No schema or migration change** (8 migrations, unchanged). **No dependency added** (no `package.json` or lockfile
  change). No server contract change. No `SALE`, cost, valuation, accounting or tax behaviour.

## Summary

| Area                                                                                              | Result       |
| ------------------------------------------------------------------------------------------------- | ------------ |
| Audit coverage: designed action set per effective change; none for replay, no-op, denial, failure | PASS         |
| Concurrency soak: 11 scenarios, `maxAttempts: 1`, three 25-iteration runs                          | PASS (3 / 3) |
| Tenancy and location isolation (HTTP and services)                                                | PASS         |
| Permission allow/deny for every role on reversals, stocktake count/remove/post/cancel             | PASS         |
| Device trust on all 22 inventory routes and sampled catalog routes                                | PASS         |
| Dependency boundaries                                                                             | PASS         |
| Web low-stock acceptance (Playwright, real API)                                                   | PASS         |
| Android low-stock acceptance (Jest, mobile client)                                                | PASS         |
| Stale >50 client behaviour (web and mobile)                                                       | FIXED (D1)   |
| Reference Android device walkthrough (physical device, debug APK), including BLIND STOCK_KEEPER     | PASS         |
| Final gates (verify, integration, db scripts, Playwright, bundle, Expo export, boundaries, text integrity, gitleaks) | PASS |

## A. Governing decisions

- ADR-008 (ACCEPTED), ADR-005 section 15.3 (optional device verification), Plan 004 S8, and the Slice 8 decisions
  approved for this run:
  1. The physical reference device walkthrough is mandatory; no emulator substitute.
  2. Soak: `TALI_SOAK_ITERATIONS` (default 5); evidence runs at 25 iterations, three times, `maxAttempts: 1`.
  3. Stale >50 client wording and state rules (section F).
  4. JDK: an existing JDK 21 for the session only; no installation or system change.
  5. Audit semantics: each effective change writes exactly its designed action set (a priced create writes
     `product.created` and `product.price_set`, which is not a duplicate); a replay or no-op writes nothing.
  6. Device headers: absent headers pass by design (web carries none); valid credentials work; wrong, partial,
     malformed, revoked and foreign-business credentials fail.
  7. Locks: no assertion of zero global locks; the evidence is no 40P01, no unexplained serialization failure, the
     expected winner and loser, no duplicate movements, correct audit counts and consistency `[]`.

## B. Audit coverage (W2)

- Database suite `zf-build2-audit-coverage` (12 tests) reads `business_audit_records` as the owner role:
  - catalog: category create, replay, no-op update, rename, archive, re-archive; priced product create writes
    `["product.created","product.price_set"]` and its replay nothing; product update, price, archive and reactivate,
    with reasons; no-ops write nothing; description text is not copied into the payload; packs; CASHIER denials write
    nothing;
  - inventory: opening and receipt payloads (`referencePresent`, never the reference), receipt reversal; adjustment
    and write-off reason is the note when given, otherwise the reason code; reversal kinds; thresholds (set, no-op,
    clear); stocktake started, posted and cancelled; counts and removes are not audited, by design;
  - rollback: an audit writer that fails on a chosen call rolls the whole mutation back (second record of a priced
    create; stocktake post), leaving neither the change nor a partial audit;
  - payloads contain only declared fields, are at most 8 KiB, and contain no secret-like or quantity keys.
- API integration (catalog, inventory, stocktake): every mutation route over HTTP writes its envelope with
  `actorType` `user`, the acting membership, `sourceChannel` `api`, the response `x-correlation-id` and the
  idempotency key where keyed. Replays, no-ops, 409 key reuse, 400 validation failures and 403 denials write no row.
  Catalog rows have a null `locationId`; every inventory row carries the default location.

## C. Concurrency soak (W3)

- Suite `zg-inventory-concurrency-soak` (11 scenarios): decrement vs decrement, opposite-order receipts, receipt vs
  adjustment, post vs receipt, post vs adjustment, post vs post, count vs count, cancel vs post (the loser is
  `ConflictError`), create vs create (one idempotency record each), reversal vs reversal, reversal vs write-off.
- Every racer uses `maxAttempts: 1`, so no retry hides a conflict. After every iteration: movement count, per-action
  audit counts and the `inventory.*` audit total; no duplicate movement identity (type, variant, source, reversed
  movement); per balance, the `BigInt` sum of movements equals the quantity and the version equals the movement
  count; `checkInventoryConsistency` is `[]`.
- Results: default (5 iterations) 11/11 in 34 s; `TALI_SOAK_ITERATIONS=25`, run separately three times:

  | Run | Wall time | Vitest duration | Result |
  | --- | --------- | --------------- | ------ |
  | 1   | 2:14.6    | 131.47 s        | 11/11  |
  | 2   | 2:19.0    | 135.21 s        | 11/11  |
  | 3   | 2:04.6    | 120.95 s        | 11/11  |

- No 40P01, no unexplained serialization failure, no duplicate movement, no lost update.
- Command: `$env:TALI_SOAK_ITERATIONS="25"; pnpm --filter @tali/database exec vitest run --config
  vitest.integration.config.ts test/integration/zg-inventory-concurrency-soak.integration.test.ts`.

## D. Tenancy, location, permission, device trust and boundaries (W4)

- **Tenancy.** Business B gets 404 for business A's variant (opening stock through both B's and A's paths), A's
  adjustment reversal (both paths) and reads, with A's inventory and audit snapshot unchanged.
- **Location.** A second (back-store) location is inserted and a stocktake created there through the services with a
  context bound to it. Over HTTP, which resolves the default location, the list is empty and get, lines, count,
  remove, post and cancel are 404 with nothing changed.
- **Permission.** MANAGER records opening, receipt, a DECREASE adjustment and a write-off and reverses all three;
  CASHIER, ACCOUNTANT and STOCK_KEEPER get 403 on all three reversals. CASHIER and ACCOUNTANT get 403 on stocktake
  count, remove, post and cancel; MANAGER posts and cancels. Denials change nothing and write no audit row.
- **Device trust.** All 22 inventory routes (shared `INVENTORY_ROUTES`, also used by the route-guard compat test)
  and seven sampled catalog routes, each with six untrusted cases: wrong credential, device ID only, credential only,
  malformed device ID, revoked device, another business's device. Every case is 403 `DEVICE_NOT_TRUSTED` with no
  change and no audit row. A trusted device reads (200) and is validated normally (400 for a bad body; 201 for a
  catalog create).
  - Absent headers pass by design (`DeviceContextGuard`, ADR-005 section 15.3, Plan 003 section 5 step 8): the web
    client sends none. The Slice 6 audit's phrase "untrusted or missing device headers fail closed" means a missing
    half of the pair (one header without the other); that is what fails closed. Not a bypass; no change made.
- **Boundaries.** `pnpm boundaries`: no violations (703 modules, 3649 dependencies). Rules reviewed include
  `ai-no-catalog-inventory`, `clients-only-client-safe-packages`, `api-controllers-not-to-adapters` and
  `domain-no-runtime-dependencies`; no gap found.
- No cross-tenant, cross-location, permission or device bypass was found.

## E. Low-stock acceptance (W5)

- **Web**, `apps/web/e2e/low-stock.spec.ts` against the compiled API and a production web build: threshold 10 and
  opening 15 (no badge); DECREASE 5 to 10 (LOW STOCK in the list and on the item, since low means on hand at or below
  the threshold); receipt 3 to 13 (badge clears); DECREASE 8 to 5 (LOW STOCK, present in `lowStock=true`); archive
  (still listed and marked Archived, no LOW STOCK, absent from `lowStock=true` in the API and the UI filter). Each
  state is checked against the API's `lowStock` value read with the owner's token. Nothing is stored in the browser.
- **Android client**, `apps/mobile/test/inventory.test.tsx` "mobile low-stock sequence": the same sequence through the
  mobile screens (adjustment, receipt, archive), the badge following the API boolean in the list and on the item, the
  `lowStock=true` filter, and no `locationId` in any request.
- The physical device part of Android acceptance is covered by section G (passed).

## F. Defect D1: stale >50 guidance lost after recounting (fixed)

- **Found by:** the Slice 8 review of `STOCKTAKE_STALE` (W1 matrix), confirmed by new tests that failed first.
- **Defect.** The API lists at most 50 stale variant IDs with the total `staleLineCount`. Both clients derived "the
  first M are marked" from the shrinking set of marked IDs, and hid the warning once every marked line was
  recounted. With more than 50 stale lines, a user who recounted the listed lines lost all guidance that more were
  stale, although posting would still be refused. No stock or audit effect (the server refuses every stale post);
  the defect was misleading client guidance only.
- **Fix** (both detail screens, identical logic; no server contract change):
  - the stale state keeps the total `lineCount`, the original `listedCount` and the still-marked IDs separately;
    `listedCount` is never computed from the shrinking set;
  - the warning remains while `lineCount > listedCount`, even after every listed line is recounted, and shows:
    "More items changed than Tali can list at once. Recount the marked items, then try posting again. If more items
    still need recounting, Tali will show the next group. Nothing will post until all changed items are recounted.";
  - "N items are affected; the first M are marked below." uses `listedCount` while marks remain;
  - a new `STOCKTAKE_STALE` replaces the whole batch; only a successful post clears the stale state.
- **Tests** (web Vitest and mobile Jest): the server reports `staleLineCount` 120 and lists 50 stale IDs; all 50 are
  recounted and the warning remains, because the total exceeds the bounded listed count; a second post reports 70 and
  lists a new batch of 50 that overlaps the first, and the new response replaces the marked batch (10 lines drop
  their mark, 40 are marked again, 10 are newly marked); a final successful post clears the stale state. The existing
  stale and replay tests are unchanged and pass.
- **Test-fixture optimization, not reduced server semantics** (approved by the human maintainer on 2026-10-11). The
  fakes serve only the 60 line objects the two batches list, not 120 rendered rows. The server semantics under test
  are unchanged: 120 stale lines in total, at most 50 listed per response, overlapping batches allowed. The smaller
  fixture validates the client state machine without a synthetic rendering workload: with 120 rows, each recount
  re-rendered every row and the tests took 57 s (mobile) and 27 s (web), which starved the suites running beside them
  in `pnpm verify` (section H).

## G. Reference Android device walkthrough (PASS)

- **2026-10-10: blocked.** `adb devices -l` listed no device; no usable JDK 21 (`java` on PATH was 1.8.0_202 and
  `JAVA_HOME` pointed to a missing folder). No emulator was substituted and no JDK was installed (decisions 1 and 4).
- **2026-10-11: passed.** Performed by the human maintainer on the **physical reference device, not an emulator**.
  - Device: Samsung SM-F936U1, Android 16, API level 36, ABI `arm64-v8a`, connected through ADB. The device serial
    number is deliberately not recorded in the repository.
  - Build: a **debug/development APK, not a release APK**, built with OpenJDK 21.0.8 (`JAVA_HOME` set for the build
    session only to the existing `C:\Program Files\Android\Android Studio2\jbr`). Installed package `versionName`
    0.0.0, `versionCode` 1, `minSdk` 24, `targetSdk` 36.
  - APK SHA-256 (as captured in the external evidence):
    `A83C55FA965A47BA8C4537992EE7650EEE881791975A6ABDBBCA46C4ED356823`.
  - Environment: `EXPO_PUBLIC_TALI_ENV=local`, `EXPO_PUBLIC_AUTH_MODE=local`, the local API on the LAN at
    `http://192.168.1.226:3000`. The phone reached the API over the LAN and showed environment local, that API URL,
    API health ready, database up, and local development sign-in.
- **Catalog flows (PASS):** local sign-in; profile and business setup; Catalog navigation; create a tracked product;
  SKU and stock-unit configuration; selling price set and displayed; product detail; product edit.
- **Inventory flows (PASS):**
  - Inventory navigation, stock list, item detail; opening stock; low-stock threshold set;
  - stock above the threshold: no LOW STOCK; a decrease adjustment to the threshold: LOW STOCK appeared from the
    refreshed API state; a goods receipt above the threshold: LOW STOCK cleared;
  - write-off and its reversal; movement history refreshed;
  - archived product with residual stock stayed visible, labelled Archived, with no LOW STOCK indicator.
- **FULL stocktake as OWNER (PASS):** count; review with expected quantity and difference; post.
- **Genuine `STOCKTAKE_STALE` (PASS):** stock moved after the count; posting returned `STOCKTAKE_STALE`; the stale
  item was marked; after a recount, a later post succeeded.
- **BLIND STOCK_KEEPER (PASS):** a STOCK_KEEPER joined the same business and opened the in-progress DRAFT stocktake;
  the BLIND-count message was shown; no expected quantity and no difference, before or after saving a count; the
  count saved; no Post and no Cancel action was offered.
- **OWNER FULL review (PASS):** the OWNER then saw the same stocktake in FULL mode and kept finish and cancel
  authority.
- Screenshots and the other evidence are kept outside the repository by the maintainer; they are not repository
  artifacts and none is copied here.
- Release readiness is **not** claimed: this is a debug APK against a local API.

## H. Final gates, run one at a time

### H.1 Before the walkthrough (W6, 2026-10-10)

| Gate                                                            | Result                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm verify`                                                   | exit 0 (18 of 18 tasks), about 5:13 wall; failed runs below    |
| `pnpm test:integration` (includes the soak at 5 iterations)     | exit 0 in 8:37.7: database 485, worker 9 + 1 skipped, API 179 + 1 skipped |
| `db:migrate:status`, `db:drift`, `db:verify-schema`, `db:inventory-consistency` | up to date (8 migrations); drift ok both ways; verification passed; consistency passed |
| Playwright `playwright.config.ts`                               | 13 passed (1:57 wall), including `low-stock.spec.ts`           |
| Playwright `playwright.cognito.config.ts`                       | 5 passed (0:38 wall)                                            |
| Expo Android export                                             | exit 0 (2:07)                                                   |
| Client bundle check                                             | web, mobile JS, mobile Hermes and public config clean          |
| `pnpm boundaries`; `pnpm text-integrity`                        | no violations; 777 files UTF-8 without BOM                     |
| gitleaks v8.30.1: history, changed-tree directory scan, temporary committed clone | no leaks                                    |

Baseline at `ad53807` (W1): verify exit 0; integration exit 0 in 9:37.87 (database 462, worker 9 + 1 skipped, API
169 + 1 skipped); db scripts ok.

Failed runs, each investigated to root cause:

1. `verify`: Prettier reported six new or edited test files. Formatted; not a product issue.
2. `verify`: ESLint reported four errors in new test code (a multiline property access, an unnecessary optional
   chain, a redundant `Number()`, an unsafe `any` assignment). Fixed in the tests.
3. `verify`: `business-route-guards.test.ts` `beforeAll` timed out at 10 s. The hook only bootstraps Nest without
   touching the database; alone the file passes 29/29 with tests 4% of 11.7 s, and the run showed 129 s of module
   transforms (CPU contention). No assertion failed. **One documented retry.**
4. The retry: the API passed; `cognito-onboarding.test.tsx` exceeded its 30 s test timeout (normally 2.6 s; it runs
   an SRP double, which is CPU-bound). Not retried again. Root cause: the new 120-line stale tests cost 57 s (mobile)
   and 27 s (web) of single-threaded rendering beside the other suites. The fixtures were reduced to the 60 lines the
   two batches list (mobile 28 s, web 18 s) without changing the scenario, then `verify` passed.

A shell wrapper quirk twice reported the log file as locked while the single `verify` it had started kept running; a
process check confirmed one `verify` at a time, and its log was read after it exited.

### H.2 After the walkthrough (finished tree, 2026-10-14 to 2026-10-15)

Only documentation changed after H.1 (this audit, `build-2-final.md`, Plan 004); no production or test code. The
test database is the compose `postgres-test` container on `127.0.0.1:55433` (tmpfs, so every container start is an
empty database that the integration global setup migrates with `prisma migrate deploy`).

| Gate                                                            | Result                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm verify`                                                   | exit 0 after the H.2 edits (2:52.7; 18 of 18 turbo tasks replayed from cache, code inputs unchanged; the root checks ran fresh)    |
| `pnpm test:integration --force` (every task executed; nothing replayed from the turbo cache) | exit 0 in 9:29.0, 12 of 12 tasks: database 485, worker 9 + 1 skipped, API 179 + 1 skipped; failed runs below |
| `db:migrate:status`, `db:drift`, `db:verify-schema`, `db:inventory-consistency` | up to date (8 migrations); drift ok both ways; verification passed; balances match the movement ledger |
| `pnpm boundaries`                                               | no violations (703 modules, 3649 dependencies)                 |
| Client bundle check                                             | web (40 files), mobile JS (37), mobile Hermes (37) and public config (1) clean |
| Expo Android export                                             | exit 0                                                          |
| `pnpm text-integrity`                                           | 779 files UTF-8 without BOM or null bytes                      |
| `git diff --check`; trailing whitespace in untracked files      | clean; none                                                     |
| gitleaks v8.30.1                                                | no leaks: history (28 commits), changed-tree directory scan (17 files), temporary committed clone (29 commits, deleted after the scan) |
| Playwright                                                      | not rerun: no client code changed since H.1 (13 and 5 passed)  |
| Concurrency soak at 25 iterations                               | not rerun: no inventory or concurrency code changed; the three runs in section C stand |

Failed `pnpm test:integration` runs on the finished tree, in order:

5. Turbo replayed cached builds; exit 1 in 56.6 s. The worker test "fails fast with exit code 1 on invalid
   configuration, never printing values" exceeded its 20 s timeout; the other worker process tests passed.
6. `--force`: exit 1 in 39:51. Database 485/485 executed and passed. All three Windows-run worker process tests
   timed out (two at 20 s; the smoke start waited 8 s with no child output at all). The maintainer's walkthrough
   processes were still running (Expo Metro using about 1.4 cores while idle and about 44 CPU-seconds per worker
   rebuild, the local API and a Gradle daemon). With the maintainer's approval they were stopped.
7. `--force`: exit 1 after 4:21. Both compose containers had exited with code 255 (Docker engine restart), so the
   global setup failed with `P1001` before any test ran. The containers were restarted and reported healthy.
8. `--force`: exit 1 in 10:21. Database 485/485 passed; the same first worker process test timed out at 20 s; the
   other worker tests passed.
9. `--force`: exit 0, the gate result above. Turbo scheduled the worker task before the database task in this run.

Investigation of the worker timeout (runs 5, 6 and 8):

- Slice 8 changes nothing in `apps/worker` or `packages/config` (no diff against the base). The failing path loads
  the configuration, writes one fatal line naming the invalid keys and exits 1.
- Standalone spawns of the same compiled entry with the same environment exit 1 in 2.1 to 4.5 s, naming
  `DATABASE_URL` and `WORKER_POLL_INTERVAL_MS` and never the value: at rest, immediately after a forced rebuild of the
  worker and its dependencies, and immediately after a full database integration suite.
- The worker integration suite passes alone (directly, 9 + 1 skipped), under turbo filtered to the worker, under turbo
  filtered to the database and the worker, and directly right after the database suite.
- No Windows System or Defender events, and no resource-exhaustion events, were logged in the failure window.
- Every failure occurred in the full turbo pipeline with the worker task scheduled after the database task; in
  each, the first child process the suite started produced no output before the timeout. No assertion failed in any
  run, and whenever the child ran it behaved as asserted.
- Root cause **not isolated** beyond this. No production or test code was changed and no timeout was raised. This
  is recorded as an open, intermittent test-environment issue for human review (section I). It does not affect the
  Slice 8 change set.

## I. Limitations

- Release readiness is not claimed: the device walkthrough used a debug APK against a local API.
- Automated Android low-stock acceptance runs against the mobile client with a scripted API; the real-API checks are
  the web Playwright spec and the manual device walkthrough.
- The soak is bounded (25 iterations per scenario, two racers); it is evidence, not a proof of absence.
- The stale >50 tests use 60 served line objects with a server-reported total of 120 (section F, test-fixture
  optimization).
- Open: on this Windows host, the first worker process test intermittently times out at 20 s in the full
  `pnpm test:integration` pipeline when the worker task runs after the database task (section H.2). Root cause not
  isolated; the worker code is unchanged by Slice 8 and the suite passes in isolation.
