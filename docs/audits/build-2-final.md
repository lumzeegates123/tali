# Build 2 final audit: product catalog and inventory

- Date: 2026-10-15 (final gates; the reference device walkthrough was on 2026-10-11)
- Status: **Build 2 COMPLETE** (Slices 0 to 8; all gates passed, including the reference Android device walkthrough;
  pending human review; the Slice 8 change set is not committed or pushed). **Production release readiness is not
  claimed.**
- Plan: `docs/plans/004-build-2-catalog-inventory.md`. Design: `docs/decisions/ADR-008-catalog-quantity-inventory.md`
  (ACCEPTED 2026-10-05, unchanged by every slice).
- This record summarizes acceptance across the slices; the evidence is in each slice audit, `build-2-slice-1.md`
  to `build-2-slice-8.md`. Where this summary and a slice audit differ, the slice audit is the detailed record.

## Slices

| Slice | Content                                                                                           | Audit                     | Result                    |
| ----- | ------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------- |
| 0     | ADR-008 accepted, Plan 004, mvp-scope approved decision, open decision 9 narrowed                 | (ADR-008, Plan 004)       | COMPLETE 2026-10-05       |
| 1     | Catalog domain and application: `Quantity`, units, product/variant/category/pack, price history  | `build-2-slice-1.md`      | COMPLETE 2026-10-05       |
| 2     | Catalog schema, migration, `verify-schema` expectations, repositories                            | `build-2-slice-2.md`      | COMPLETE 2026-10-05       |
| 3     | Catalog API and shared contracts                                                                  | `build-2-slice-3.md`      | COMPLETE 2026-10-05       |
| 4     | Catalog clients (web and mobile)                                                                  | `build-2-slice-4.md`      | COMPLETE 2026-10-06       |
| 5     | Inventory core: movements, balances, opening, receipts, adjustments, write-offs, reversals, thresholds | `build-2-slice-5.md` | COMPLETE 2026-10-08       |
| 6     | Stocktake and the inventory API (22 routes), threshold endpoints                                  | `build-2-slice-6.md`      | COMPLETE 2026-10-09       |
| 7     | Inventory clients (web and mobile), LOW STOCK indicator, threshold management                    | `build-2-slice-7.md`      | COMPLETE 2026-10-09       |
| 8     | Hardening and final acceptance, reference Android device walkthrough                             | `build-2-slice-8.md`      | COMPLETE 2026-10-15       |

## Architecture

- **Application and domain stay authoritative.** Every catalog and inventory rule (quantity units and precision,
  negative-stock refusal, state transitions, stocktake staleness, permissions, audit) lives in
  `packages/domain` and `packages/application`; controllers parse input, resolve the business context and call one
  use case (Slices 1, 3, 5, 6).
- **No AI reaches inventory or catalog repositories.** The dependency-cruiser rule `ai-no-catalog-inventory` and the
  module surface rules pass with no violations (`pnpm boundaries`, Slice 8: 703 modules, 3649 dependencies). There is
  no AI code in Build 2.
- **Clients are non-authoritative.** Web and mobile render API responses validated with the shared strict schemas;
  they hold no stock arithmetic, no LOW STOCK derivation and no location authority (Slices 4, 7; reviewed in Slice 8).
- ADR-008 was never amended. No new datastore or service. Slice 8 adds no dependency; each earlier slice audit
  records its own dependency review.

## Inventory integrity

- **Append-only movements.** `inventory_movements` has SELECT and INSERT grants only (no UPDATE or DELETE); every
  stock change is a canonical movement type with a `location_id`; corrections are reversals that reference the
  original; stock is never set by overwrite, and a stocktake posts `COUNT_CORRECTION` differences (Slices 5, 6).
- **Balance consistency.** Balances are a version-guarded projection of the movements; `db:inventory-consistency`
  and the in-test consistency check stay empty; the Slice 8 soak proves after every iteration that each balance
  equals the `BigInt` sum of its movements and its version equals the movement count.
- **No overselling under tested races.** A decrease below zero is `INSUFFICIENT_STOCK`; concurrent decrements leave
  exactly one winner (Slice 5 race tests; Slice 8 soak decrement and reversal-versus-write-off scenarios).
- **Concurrency soak (Slice 8).** 11 scenarios, every racer with `maxAttempts: 1`, three separate 25-iteration runs:
  11/11 each (2:14.6, 2:19.0, 2:04.6 wall). No deadlock (40P01), no unexplained serialization failure, no duplicate
  movement, no lost update. The default 5-iteration soak also runs in every `pnpm test:integration`.
- **Stocktake staleness protection.** A post whose counted lines no longer match the balances is refused with
  `STOCKTAKE_STALE` (at most 50 IDs listed, with the total count); nothing is posted until the stale lines are
  recounted (Slice 6). Slice 8 fixed the client guidance when more than 50 lines are stale (defect D1, client-only)
  and confirmed a genuine stale post, recount and successful post on the reference device.
- **Idempotency and version protection.** Keyed creations claim their `Idempotency-Key` before any stock lock and
  replay instead of double-posting; a reused key with another body is rejected; versioned writes (thresholds,
  stocktake lines, stocktake post and cancel) fail with `VERSION_CONFLICT` on a stale version (Slices 5, 6, soak).
- **Audit.** Each effective change writes exactly its designed audit action set in the same transaction; replays,
  no-ops, denials and failures write none; a failed audit write rolls the change back (Slice 8 review).

## Security

- **Tenant isolation.** Every repository method takes `businessId`; tenant-composite foreign keys reject cross-tenant
  references in the database; another business's records answer 404 over HTTP with nothing changed (Slices 2, 5, 6;
  Slice 8 HTTP review).
- **Location isolation.** The API resolves the default location server-side and never accepts a client `locationId`;
  a stocktake at another location is invisible and unchangeable over HTTP (Slice 8).
- **Roles and permissions.** Checked server-side before idempotency and re-read inside the transaction; CASHIER and
  ACCOUNTANT cannot mutate stock; STOCK_KEEPER cannot adjust, reverse, post or cancel; only FULL-visibility roles see
  expected quantities (Slices 5, 6; Slice 8 allow/deny matrix).
- **Device credentials.** When device headers are supplied they must identify an ACTIVE device of the same business
  with a matching credential: wrong, partial, malformed, revoked and foreign-business credentials fail closed with
  403 `DEVICE_NOT_TRUSTED` on all 22 inventory routes and sampled catalog routes, with no change (Slice 8).
- **Approved no-device-header behaviour.** A request without device headers is unchanged by design
  (`DeviceContextGuard`, ADR-005 section 15.3); this is how the web client works and is not a bypass.
- Secrets: the Slice 8 final gitleaks scans (repository history, the changed tree, and a temporary clone with the
  change set committed) find no leaks.

## Client safety

- **LOW STOCK from the API flag only**, never derived on the client and never shown for archived items (Slice 7;
  Slice 8 web Playwright, mobile Jest and the device walkthrough).
- **No client stock calculation**: on-hand quantities, variances and LOW STOCK are displayed as the API returns them.
- **BLIND and FULL separation**: BLIND counters never receive or render `expectedAtCount` or `variance`, and get no
  post or cancel action; FULL roles see them (Slices 6, 7; confirmed on the device with a STOCK_KEEPER and an OWNER).
- **No `locationId` authority**: clients never send a location; the API resolves it.
- **No offline inventory persistence**: no tenant data, token or device credential in browser or device storage
  (store and Playwright storage checks).
- **Bundle scans clean**: web, Expo Android and iOS JavaScript, Hermes bytecode and the public app config (Slice 8
  final scan).

## Hardware

- The reference Android device walkthrough **passed** on 2026-10-11, performed by the human maintainer on the physical
  device (Samsung SM-F936U1, Android 16, API 36, `arm64-v8a`; debug APK built with OpenJDK 21.0.8; local API over the
  LAN). It covered the catalog flows, the inventory flows with LOW STOCK appearing and clearing, archived residual
  stock, a FULL stocktake, a genuine `STOCKTAKE_STALE` with recount and post, a BLIND STOCK_KEEPER count, and OWNER
  FULL review with finish authority. Details and the APK SHA-256: `build-2-slice-8.md` section G. Screenshots are kept
  outside the repository; no device serial is recorded.

## Final evidence (Slice 8, finished tree)

See `build-2-slice-8.md` section H for the post-walkthrough gate results: `pnpm verify`, `pnpm test:integration`,
the database scripts, `pnpm boundaries`, the client bundle scan, the Expo Android export, text integrity,
`git diff --check` and gitleaks. Web Playwright for Slice 8 passed 13 (including `low-stock.spec.ts`) and 5 (Cognito)
on 2026-10-10 with unchanged client code.

Open item for human review: on the Windows development host, the first worker process test intermittently timed out
at 20 s in the full `pnpm test:integration` pipeline (three of the four runs on the finished tree that reached the
worker suite; the final run passed 12 of 12 tasks). The worker is unchanged by Build 2 Slice 8, the suite passes in isolation, and no assertion failed;
the root cause is not isolated (`build-2-slice-8.md` section H.2).

## Limitations and deferred scope

Build 2 is quantity-only catalog and inventory. Production release readiness is **not** claimed. Deferred to Build 3
or later, each with its own decision where the plan requires one (Plan 004 sections 6 and 7):

- sales and POS checkout; `SALE` movements;
- receivables;
- suppliers and purchasing;
- costing, inventory valuation and COGS (ADR-009);
- accounting and the ledger (ADR-009);
- tax (ADR-010);
- pack selling and pack prices;
- offline synchronization of catalog and inventory (sync ADR);
- camera barcode scanning;
- AI and voice;
- forecasting and reorder automation (no notifications, reorder points or automatic purchasing are implied by LOW
  STOCK);
- transfers between locations (post-MVP).

Known residual risks are those in Plan 004 section 8 (for example, merchants may expect to sell whole cartons before
Build 3, and the staleness rule may cause recounts in busy shops once sales exist).
