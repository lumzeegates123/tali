// @ts-check
/**
 * Package and module boundaries (ADR-002 sections 6, 7 and 19).
 * This file is the single source of truth for dependency direction. Rules for
 * packages and apps that do not exist yet are intentional: boundaries are in
 * place before the code is written.
 */

const TEST_FILE = "\\.(test|spec)\\.[cm]?[jt]sx?$";
const PACKAGE_TESTING = "^packages/application/src/testing/";
const PACKAGE_TEST_CONTRACTS = "^packages/application/src/testing/contracts/";

const FRAMEWORK_NPM =
  "node_modules/(@nestjs|@prisma|prisma|@aws-sdk|aws-sdk|express|fastify|koa|hono|bullmq|bull|amqplib|kafkajs|ioredis|redis|pg|postgres|axios|node-fetch|react|react-native|next|expo|expo-[^/]+)/";

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    // ---- Repository-wide hygiene ------------------------------------------
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies are forbidden.",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "Every import must resolve (catches undeclared or misspelled dependencies).",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-undeclared-npm-dependency",
      severity: "error",
      comment:
        "Packages may import only npm packages declared in their own package.json. dependency-cruiser also reports npm-no-pkg for a package named in peerDependenciesMeta, so an edge that is declared in a real dependency field is not undeclared.",
      from: {},
      to: {
        dependencyTypes: ["npm-no-pkg", "npm-unknown"],
        dependencyTypesNot: ["npm", "npm-dev", "npm-optional", "npm-peer"],
      },
    },
    {
      name: "production-not-to-dev-dependency",
      severity: "error",
      comment: "Production source may not import devDependencies (test files and port contract suites excepted).",
      from: { path: "^(packages|apps)/[^/]+/src/", pathNot: [TEST_FILE, PACKAGE_TEST_CONTRACTS] },
      to: { dependencyTypes: ["npm-dev"] },
    },

    // ---- Vendor SDK placement ---------------------------------------------
    {
      name: "aws-sdk-only-in-integrations",
      severity: "error",
      from: { pathNot: "^packages/integrations/" },
      to: { path: "node_modules/(@aws-sdk|aws-sdk)/" },
    },
    {
      name: "prisma-only-in-database",
      severity: "error",
      from: { pathNot: "^packages/database/" },
      to: { path: "node_modules/(@prisma|prisma)/" },
    },
    {
      name: "pg-only-in-database",
      severity: "error",
      comment: "The PostgreSQL driver is an implementation detail of packages/database.",
      from: { pathNot: "^packages/database/" },
      to: { path: "node_modules/(pg|pg-[^/]+|@prisma/adapter-pg)/" },
    },
    {
      name: "jose-only-in-integrations",
      severity: "error",
      comment: "JWT handling is an identity-adapter concern (Build 1 Slice 3 audit).",
      from: { pathNot: "^packages/integrations/" },
      to: { path: "node_modules/jose/" },
    },
    {
      name: "local-identity-no-filesystem",
      severity: "error",
      comment: "The local signing key is generated per process and never persisted or loaded (ADR-005 section 16).",
      from: { path: "^packages/integrations/src/local/" },
      to: { dependencyTypes: ["core"], path: "^(node:)?(fs|fs/promises)$" },
    },
    {
      name: "database-test-fixtures-not-in-production",
      severity: "error",
      comment: "Test-only fixture tables and adapters (packages/database/test) are never reachable from shipped code.",
      from: { path: "^(apps|packages)/[^/]+/src/", pathNot: TEST_FILE },
      to: { path: "^packages/database/test/" },
    },
    {
      name: "database-testing-is-not-production",
      severity: "error",
      comment: "@tali/database/testing is for integration tests only.",
      from: { path: "^(apps|packages)/[^/]+/src/", pathNot: ["^packages/database/", TEST_FILE] },
      to: { path: "^packages/database/src/testing/" },
    },
    {
      name: "nestjs-only-in-server-apps",
      severity: "error",
      from: { pathNot: "^apps/(api|worker)/" },
      to: { path: "node_modules/@nestjs/" },
    },

    // ---- packages/domain --------------------------------------------------
    {
      name: "domain-depends-on-nothing-internal",
      severity: "error",
      comment: "packages/domain depends on no other workspace package.",
      from: { path: "^packages/domain/" },
      to: { path: "^(packages|apps|tooling)/", pathNot: "^packages/domain/" },
    },
    {
      name: "domain-no-runtime-dependencies",
      severity: "error",
      comment: "Domain source is pure: no npm packages and no Node.js built-ins (clocks, randomness, I/O).",
      from: { path: "^packages/domain/src/", pathNot: TEST_FILE },
      to: { dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "core"] },
    },
    {
      name: "kernel-is-self-contained",
      severity: "error",
      comment: "The client-safe kernel may not import domain/modules/** or anything outside the kernel.",
      from: { path: "^packages/domain/src/kernel/" },
      to: { path: "^packages/domain/src/", pathNot: "^packages/domain/src/kernel/" },
    },
    {
      name: "domain-module-public-surface",
      severity: "error",
      comment: "Cross-module imports go through the other module's index.ts.",
      from: { path: "^packages/domain/src/modules/([^/]+)/" },
      to: {
        path: "^packages/domain/src/modules/[^/]+/.+",
        pathNot: ["^packages/domain/src/modules/$1/", "^packages/domain/src/modules/[^/]+/index\\.ts$"],
      },
    },

    // ---- packages/application ---------------------------------------------
    {
      name: "application-depends-only-on-domain",
      severity: "error",
      comment:
        "packages/application may depend only on packages/domain (never shared, config, database, integrations).",
      from: { path: "^packages/application/" },
      to: { path: "^(packages|apps|tooling)/", pathNot: "^packages/(application|domain)/" },
    },
    {
      name: "application-framework-free",
      severity: "error",
      comment: "No frameworks, ORMs, SDKs, queue clients, HTTP libraries or Node.js built-ins in application source.",
      from: { path: "^packages/application/src/", pathNot: [TEST_FILE, PACKAGE_TEST_CONTRACTS] },
      to: { dependencyTypes: ["core", "npm", "npm-optional", "npm-peer"], pathNot: "^packages/domain/" },
    },
    {
      name: "application-no-external-runtime-dependencies",
      severity: "error",
      comment:
        "ADR-006: application source, including the port contract suites, imports no external npm package, whatever its package.json declares. Its only runtime dependencies are approved workspace packages (currently @tali/domain; the manifest is checked by tooling/dependency-cruiser/application-policy.mjs). Contract suites may import the vitest test runner; application-framework-free keeps it out of other production source.",
      from: { path: "^packages/application/src/", pathNot: TEST_FILE },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled", "npm-no-pkg", "npm-unknown"],
        pathNot: ["^packages/domain/", "node_modules/vitest/"],
      },
    },
    {
      name: "application-testing-is-not-production",
      severity: "error",
      comment: "Fakes under application/src/testing are for tests and local composition only.",
      from: { path: "^packages/application/src/", pathNot: [PACKAGE_TESTING, TEST_FILE] },
      to: { path: PACKAGE_TESTING },
    },
    {
      name: "application-module-public-surface",
      severity: "error",
      from: { path: "^packages/application/src/modules/([^/]+)/" },
      to: {
        path: "^packages/application/src/modules/[^/]+/.+",
        pathNot: ["^packages/application/src/modules/$1/", "^packages/application/src/modules/[^/]+/index\\.ts$"],
      },
    },

    // ---- packages/shared and packages/config ------------------------------
    {
      name: "shared-depends-on-no-workspace-package",
      severity: "error",
      comment: "packages/shared contains wire contracts only (Zod), with no internal dependencies.",
      from: { path: "^packages/shared/" },
      to: { path: "^(packages|apps|tooling)/", pathNot: "^packages/shared/" },
    },
    {
      name: "config-depends-on-no-workspace-package",
      severity: "error",
      from: { path: "^packages/config/" },
      to: { path: "^(packages|apps|tooling)/", pathNot: "^packages/config/" },
    },
    {
      name: "public-config-not-to-server-config",
      severity: "error",
      comment:
        "Client runtime configuration (public/ and the common module it imports) never reaches server configuration, server variable names or the build-time checks.",
      from: {
        path: ["^packages/config/src/public/", "^packages/config/src/common/environment\\.ts$"],
        pathNot: "\\.test\\.ts$",
      },
      to: {
        path: [
          "^packages/config/src/server/",
          "^packages/config/src/common/server-keys\\.ts$",
          "^packages/config/src/public-build/",
        ],
      },
    },

    // ---- Adapter packages (created in Wave B) -----------------------------
    {
      name: "database-direction",
      severity: "error",
      from: { path: "^packages/database/" },
      to: { path: ["^packages/(integrations|shared|ai|ui)/", "^apps/"] },
    },
    {
      name: "integrations-direction",
      severity: "error",
      from: { path: "^packages/integrations/" },
      to: { path: ["^packages/(database|shared|ai|ui)/", "^apps/", "node_modules/(@prisma|prisma|@nestjs)/"] },
    },
    {
      name: "ai-direction",
      severity: "error",
      from: { path: "^packages/ai/" },
      to: { path: ["^packages/(database|integrations|ui)/", "^apps/"] },
    },
    {
      name: "ui-direction",
      severity: "error",
      from: { path: "^packages/ui/" },
      to: { path: ["^packages/(application|database|integrations|ai)/", "^packages/config/src/server/", "^apps/"] },
    },
    {
      name: "packages-not-to-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },

    // ---- Apps (created in Waves B and C) ----------------------------------
    {
      name: "apps-not-to-other-apps",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
    {
      name: "clients-only-client-safe-packages",
      severity: "error",
      comment: "Web and mobile may import only shared, config/public, ui and domain/kernel (ADR-002 section 6).",
      from: { path: "^apps/(web|mobile)/" },
      to: {
        path: [
          "^packages/(application|database|integrations|ai)/",
          "^packages/config/src/server/",
          "^packages/domain/src/(?!kernel/)",
          "node_modules/(@aws-sdk|aws-sdk|@prisma|prisma|@nestjs|pg|postgres)/",
        ],
      },
    },
    {
      name: "clients-no-direct-identity-sdk",
      severity: "error",
      comment:
        "Clients never verify JWTs and never use Amplify internals (including @aws-amplify/react-native) or amazon-cognito-identity-js (REFRESH_TOKEN_AUTH); web and mobile use only the public aws-amplify package (ADR-003, ADR-007, Build 1 Slice 6 dependency audit).",
      from: { path: "^apps/(web|mobile)/" },
      to: { path: "node_modules/(jose|@aws-amplify|amazon-cognito-identity-js)/" },
    },
    {
      name: "mobile-amplify-only-in-cognito-module",
      severity: "error",
      comment:
        "aws-amplify is confined to the mobile Cognito boundary module, which installs Tali's SecureStore adapter before configuring Amplify (ADR-007 section 6.3); its test may inspect that order.",
      from: {
        path: "^apps/mobile/",
        pathNot: [
          "^apps/mobile/src/auth/cognito/amplify-cognito-auth\\.ts$",
          "^apps/mobile/test/amplify-init-order\\.test\\.ts$",
        ],
      },
      to: { path: "node_modules/aws-amplify/" },
    },
    {
      name: "mobile-no-amplify-runtime-peers",
      severity: "error",
      comment:
        "AsyncStorage, the random-values polyfill and NetInfo are installed only for Amplify's own use; Tali code never imports them and never persists anything in AsyncStorage (ADR-007 section 6.2).",
      from: { path: "^apps/mobile/" },
      to: {
        path: "node_modules/(@react-native-async-storage|react-native-get-random-values|@react-native-community/netinfo)/",
      },
    },
    {
      name: "web-amplify-only-in-cognito-module",
      severity: "error",
      comment:
        "aws-amplify is confined to the web Cognito auth module so the rest of the web app stays provider-neutral.",
      from: { path: "^apps/web/", pathNot: "^apps/web/src/lib/auth/cognito/" },
      to: { path: "node_modules/aws-amplify/" },
    },
    {
      name: "server-no-cognito-client",
      severity: "error",
      comment:
        "The server verifies Cognito tokens with jose in packages/integrations; it never uses a Cognito client SDK.",
      from: { path: "^(apps/(api|worker)|packages|tooling)/" },
      to: { path: "node_modules/(aws-amplify|@aws-amplify|amazon-cognito-identity-js)/" },
    },
    {
      name: "client-runtime-no-node-builtins",
      severity: "error",
      comment: "Bundled client code runs in the browser or on Hermes: no Node.js built-ins such as node:crypto.",
      from: { path: ["^apps/web/src/", "^apps/mobile/(src|app)/"] },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "client-runtime-not-to-public-build",
      severity: "error",
      comment:
        "Bundled client code never imports the build-time config checks (they carry server variable names); only next.config.ts and app.config.ts do.",
      from: { path: ["^apps/web/src/", "^apps/mobile/(src|app)/"] },
      to: { path: "^packages/config/src/public-build/" },
    },
    {
      name: "worker-handlers-not-to-database",
      severity: "error",
      comment: "Worker handlers invoke use cases; only the worker composition root wires adapters.",
      from: { path: "^apps/worker/src/handlers/" },
      to: { path: ["^packages/database/", "^packages/integrations/"] },
    },
    {
      name: "api-controllers-not-to-adapters",
      severity: "error",
      comment: "Controllers map requests to use cases; they never touch database or integration adapters.",
      from: { path: "^apps/api/src/.+\\.controller\\.ts$" },
      to: { path: ["^packages/database/", "^packages/integrations/", "node_modules/(@prisma|prisma)/"] },
    },
    {
      name: "framework-free-core",
      severity: "error",
      comment: "Domain and application never import frameworks, ORMs, SDKs, HTTP or queue libraries.",
      from: { path: "^packages/(domain|application)/" },
      to: { path: FRAMEWORK_NPM },
    },
  ],
  options: {
    // Prisma's generated client has internal import cycles; it is vendor output, reached only from packages/database.
    doNotFollow: { path: ["node_modules", "^packages/database/src/generated/"] },
    exclude: {
      // Build output only: npm packages under node_modules often ship their entry points in dist/, and excluding
      // them would drop the edge so that no rule could see the import.
      path: [
        "^(?:(?!node_modules/).)*(^|/)(dist|coverage|\\.turbo|\\.next|\\.expo|playwright-report|test-results)/",
        "^apps/mobile/(android|ios)/",
        "^apps/web/next-env\\.d\\.ts$",
      ],
    },
    tsPreCompilationDeps: true,
    // Maps exported workspace subpaths back to source; see the file for why.
    webpackConfig: { fileName: "tooling/dependency-cruiser/workspace-source-aliases.cjs" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["types", "import", "default"],
      mainFields: ["types", "module", "main"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".mjs", ".js", ".cjs", ".json"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
