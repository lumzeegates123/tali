# Package build strategy

Status: implementation decision (Wave B). It operates within ADR-002 and does
not change it: ADR-002 left the build mechanism open (plan risk R6), and this
document records how it is resolved.

## Decision

Workspace packages that run on Node.js compile with **plain `tsc`** to `dist/`.
No bundler (tsup, esbuild, swc, Rollup) is used for packages or backend apps.

| Concern | Choice |
| --- | --- |
| Module system | Native ESM (`"type": "module"`), `module`/`moduleResolution` `NodeNext` in `tooling/typescript/base.json`. |
| Relative imports | Always written with the emitted extension: `import { Money } from "./money.js"`. Required by Node's ESM resolver; enforced by `tsc` under `NodeNext`. |
| Build config | Each package has `tsconfig.build.json` (extends its `tsconfig.json`): `rootDir: src`, `outDir: dist`, `declaration`, `declarationMap`, `sourceMap`; `*.test.ts` excluded. |
| Package entry points | `exports` maps every public subpath to `./dist/**/*.d.ts` (`types`) and `./dist/**/*.js` (`default`). Nothing under `src/` is exported. |
| Ordering | Turborepo: `build`, `typecheck`, `test` and `test:integration` depend on `^build`, so dependencies are always compiled first. |
| Production runtime | `node --enable-source-maps dist/main.js`. Raw TypeScript is never executed in production. |

NestJS 12 is itself published as native ESM, so the backend apps use the same
module system with no CommonJS interop layer.

## Spike evidence

Performed against `packages/domain` and `packages/application` with a temporary
Node consumer package (`tooling/zz-build-spike`, removed after the spike):

1. `turbo run build` compiled domain, application, shared and config in
   dependency order; `dist/` contains `.js`, `.js.map`, `.d.ts`, `.d.ts.map`,
   and no test files.
2. The consumer (compiled by `tsc`, run by `node`) resolved
   `@tali/domain/kernel` to `packages/domain/dist/kernel/index.js` and
   `@tali/application` to `packages/application/dist/index.js`; `Money`
   arithmetic beyond `Number.MAX_SAFE_INTEGER`, `SequentialIdGenerator` and
   `FixedClock` behaved correctly.
3. Type declarations are enforced across the package boundary: an
   `@ts-expect-error` on `Money.ofMinor(12.5, ...)` was required (a `number`
   amount is a type error), and the runtime guard also rejected it.
4. With `--enable-source-maps`, a `KernelError` stack pointed at
   `packages/domain/src/kernel/money.ts:187` and the consumer's `src/stack.ts`;
   without the flag it pointed at `dist/kernel/money.js`.
5. `import "@tali/domain/src/kernel/money.js"` failed at compile time (TS2307)
   and at runtime (`ERR_PACKAGE_PATH_NOT_EXPORTED`): no package can reach
   another package's `src/` internals.
6. The full Wave A suite (text integrity, format, lint, typecheck, boundaries,
   179 unit tests) passed on the new layout.

## Boundary enforcement and `dist/`

Cross-package imports now resolve through `exports` into `dist/`, which
dependency-cruiser excludes. During the spike this silently removed **every**
cross-package edge from the graph (the boundary check reported no violations
because it saw no workspace edges). The fix is
`tooling/dependency-cruiser/workspace-source-aliases.cjs`, which maps each
exported subpath back to the source file it compiles from. Only exported
subpaths are aliased, so deep imports remain unresolvable. Verified by
re-counting edges (0 before the fix, 6 after) and by a probe import from
`packages/domain` to `@tali/application`, which produced a
`domain-depends-on-nothing-internal` violation. New packages and apps are
picked up automatically from their `package.json` `exports`.

## Development workflow

- `pnpm build` compiles everything in dependency order (cached by Turborepo).
- `pnpm exec turbo watch build --filter=<app>...` recompiles an app and its
  workspace dependencies on change; pair it with
  `node --watch --enable-source-maps dist/main.js` inside the app.
- Unit tests (Vitest) run against a package's own `src/`, and against
  dependencies' compiled `dist/`. Type-aware lint and `typecheck` likewise need
  dependencies built, which is why `pnpm verify` and CI run `build` before
  `lint`.

## Consequences

- A package change is not visible to its dependants until it is rebuilt
  (`turbo` does this automatically for `build`, `typecheck` and `test`).
- Relative imports must carry `.js`; forgetting it is a compile error.
- Client apps (web, mobile) consume client-safe packages through their own
  bundlers (Next.js, Metro) in Wave C; this decision covers only
  Node-executed packages and apps. See `docs/plans/002-wave-c-compatibility-checks.md`.
