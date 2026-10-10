// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Import restrictions mirror ADR-002 section 19. dependency-cruiser
 * (.dependency-cruiser.cjs) is the single source of truth for package
 * direction; these rules give fast editor feedback and cover vendor SDKs.
 *
 * Flat config replaces (does not merge) a rule for matching files, so every
 * scope below lists the global bans again via the helpers.
 */

/**
 * Import patterns are anchored regular expressions matched against the import
 * specifier (not gitignore globs, which would also match relative paths such
 * as "./contracts/http/...").
 * @typedef {{ regex: string; message: string }} PatternRule
 */

/**
 * @param {string[]} names package names or scopes ending in "/"
 */
function specifiers(names) {
  const alternatives = names.map((name) =>
    name.endsWith("/")
      ? `${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+`
      : `${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/.*)?`,
  );
  return `^(${alternatives.join("|")})$`;
}

/** @type {PatternRule[]} */
const VENDOR_SDK_BANS = [
  {
    regex: specifiers(["@aws-sdk/", "aws-sdk"]),
    message: "AWS SDKs are imported only in packages/integrations (ADR-002 section 19).",
  },
  {
    regex: specifiers(["@prisma/client"]),
    message: "@prisma/client is imported only in packages/database (ADR-002 section 19).",
  },
  {
    regex: specifiers(["@nestjs/"]),
    message: "@nestjs/* is imported only in apps/api and apps/worker (ADR-002 section 19).",
  },
  {
    regex: specifiers(["jose"]),
    message: "jose (JWT) is imported only in packages/integrations (Build 1 Slice 3 dependency audit).",
  },
  {
    regex: specifiers(["aws-amplify", "@aws-amplify/", "amazon-cognito-identity-js"]),
    message:
      "Cognito client code lives only in apps/web/src/lib/auth/cognito and apps/mobile/src/auth/cognito/amplify-cognito-auth.ts (ADR-003, ADR-007).",
  },
];

/**
 * The web and mobile Cognito modules use the public aws-amplify package
 * through its documented modular entry points only; never @aws-amplify/*
 * internals (including @aws-amplify/react-native) or
 * amazon-cognito-identity-js (REFRESH_TOKEN_AUTH).
 */
const CLIENT_COGNITO_VENDOR_BANS = [
  ...VENDOR_SDK_BANS.filter((rule) => !rule.message.startsWith("Cognito client code")),
  {
    regex:
      "^(@aws-amplify/.+|amazon-cognito-identity-js(/.*)?|aws-amplify/(?!(auth|auth/cognito|utils|adapter-core)$).+)$",
    message:
      "Use only aws-amplify, aws-amplify/auth, aws-amplify/auth/cognito, aws-amplify/adapter-core and aws-amplify/utils (Build 1 Slice 6 dependency audit).",
  },
];

/** @type {PatternRule[]} */
const FRAMEWORK_AND_INFRA_BANS = [
  {
    regex: specifiers([
      "@prisma/",
      "prisma",
      "express",
      "fastify",
      "koa",
      "hono",
      "bullmq",
      "bull",
      "amqplib",
      "kafkajs",
      "ioredis",
      "redis",
      "pg",
      "postgres",
      "axios",
      "node-fetch",
      "react",
      "react-native",
      "next",
      "expo",
      "@expo/",
    ]),
    message:
      "Domain and application code are framework-free: no HTTP frameworks, ORMs, queue clients, database drivers or UI runtimes.",
  },
  {
    regex: "^expo-.+$",
    message: "Domain and application code are framework-free: no Expo modules.",
  },
];

/** @type {PatternRule[]} */
const NODE_BUILTIN_BANS = [
  {
    regex: `^node:.+$|${specifiers(["fs", "path", "crypto", "os", "child_process", "http", "https", "net", "stream", "buffer", "util", "process", "worker_threads"])}`,
    message: "This package must stay runtime-neutral (Node.js, browser, Expo/Hermes); no Node.js built-ins.",
  },
];

/**
 * @param {string[]} packages workspace package names that are forbidden
 * @param {string} message
 * @returns {PatternRule}
 */
function workspaceBan(packages, message) {
  return { regex: specifiers(packages), message };
}

/**
 * @param {PatternRule[]} patterns
 * @param {PatternRule[]} [vendorBans]
 */
function restrictedImports(patterns, vendorBans = VENDOR_SDK_BANS) {
  return ["error", { patterns: [...vendorBans, ...patterns] }];
}

/** packages/database owns Prisma and pg; every other vendor ban still applies. */
const DATABASE_VENDOR_BANS = VENDOR_SDK_BANS.filter((rule) => !rule.message.startsWith("@prisma/client"));

/** packages/integrations owns vendor SDKs and jose, never Prisma or NestJS. */
const INTEGRATIONS_VENDOR_BANS = VENDOR_SDK_BANS.filter(
  (rule) => !rule.message.startsWith("AWS SDKs") && !rule.message.startsWith("jose"),
);

/** @type {PatternRule[]} */
const INTEGRATIONS_BANS = [
  workspaceBan(
    ["@tali/database", "@tali/shared", "@tali/ai", "@tali/ui", "@tali/api", "@tali/worker"],
    "packages/integrations implements application ports; it depends only on application and domain (ADR-002 section 6).",
  ),
  { regex: specifiers(["@prisma/", "prisma", "pg", "postgres"]), message: "Persistence is packages/database." },
  { regex: specifiers(["express"]), message: "packages/integrations is framework-free." },
];

/** The deployable apps own NestJS; every other vendor ban still applies. */
const APP_VENDOR_BANS = VENDOR_SDK_BANS.filter((rule) => !rule.message.startsWith("@nestjs/*"));

/** @type {PatternRule[]} */
const APP_PERSISTENCE_BANS = [
  {
    regex: specifiers(["@prisma/", "prisma", "pg", "postgres"]),
    message: "Apps reach PostgreSQL only through packages/database (ADR-002 section 19).",
  },
];

/** @type {PatternRule[]} */
const API_WORKSPACE_BANS = [
  workspaceBan(["@tali/worker", "@tali/ui", "@tali/ai"], "apps/api composes application, adapters and config only."),
];

/** @type {PatternRule[]} */
const WORKER_WORKSPACE_BANS = [
  workspaceBan(["@tali/api", "@tali/ui"], "apps/worker never depends on another app or on UI code."),
];

/** @type {PatternRule[]} */
const CONTROLLER_BANS = [
  workspaceBan(
    ["@tali/database", "@tali/integrations"],
    "Controllers call application use cases; they never touch adapters or persistence (ADR-002 section 19).",
  ),
];

/** @type {PatternRule[]} */
const HANDLER_BANS = [
  workspaceBan(
    ["@tali/database", "@tali/integrations"],
    "Worker handlers invoke application contracts; they never import packages/database or adapters.",
  ),
];

/** Web and mobile (ADR-002 section 6): shared contracts, public config, ui and the client-safe kernel only. */
/** @type {PatternRule[]} */
const CLIENT_BANS = [
  workspaceBan(
    ["@tali/application", "@tali/database", "@tali/integrations", "@tali/ai", "@tali/api", "@tali/worker"],
    "Web and mobile import only @tali/shared, @tali/config/public, @tali/ui and @tali/domain/kernel (ADR-002 section 6).",
  ),
  {
    regex: "^@tali/config/server(/.*)?$",
    message: "Server configuration never reaches a client. Use @tali/config/public.",
  },
  {
    regex: "^@tali/domain(/(?!kernel$).*)?$",
    message: "Clients use only the client-safe kernel: import from @tali/domain/kernel.",
  },
  {
    regex: specifiers(["@prisma/", "prisma", "pg", "postgres"]),
    message: "Clients never access a database; they call the Tali API.",
  },
];

/** Installed only for Amplify's own use on React Native (ADR-007 section 6.2); Tali code never imports them. */
/** @type {PatternRule[]} */
const MOBILE_AMPLIFY_PEER_BANS = [
  {
    regex: specifiers([
      "@react-native-async-storage/",
      "react-native-get-random-values",
      "@react-native-community/netinfo",
    ]),
    message:
      "AsyncStorage, the random-values polyfill and NetInfo are Amplify's own dependencies: Tali never imports them and never persists anything in AsyncStorage (ADR-007 section 6.2).",
  },
];

/** Client runtime code (bundled): no build-time config checks, which carry server variable names. */
/** @type {PatternRule[]} */
const CLIENT_RUNTIME_BANS = [
  {
    regex: "^@tali/config/public-build$",
    message:
      "@tali/config/public-build is for next.config.ts and app.config.ts only; it carries server variable names.",
  },
  ...NODE_BUILTIN_BANS,
];

/** NestJS modules are decorated classes with static factories by design. */
const NEST_CLASS_RULES = {
  "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }],
};

/**
 * Append-only models: the application role has no UPDATE/DELETE grant (the
 * database enforces it); this gives the same answer at lint time (ADR-002
 * section 19). Add each protected model's Prisma delegate name here, in the
 * same change as the migration that revokes its UPDATE/DELETE.
 * @type {string[]}
 */
const PROTECTED_MODEL_DELEGATES = [
  "currency",
  "externalIdentity",
  "businessAuditRecord",
  "platformAuditRecord",
  "userIdempotencyRecord",
  "businessIdempotencyRecord",
  "unitOfMeasure",
  "productVariantPrice",
  "inventoryMovement",
  "inventoryOpeningBatch",
];
/**
 * Models that are updated through audited status changes but never
 * hard-deleted (ADR-005 section 20; ADR-008 section 14); the application role
 * has no DELETE grant.
 * @type {string[]}
 */
const NO_DELETE_MODEL_DELEGATES = [
  "user",
  "business",
  "businessLocation",
  "businessMembership",
  "businessInvitation",
  "device",
  "productCategory",
  "product",
  "productVariant",
  "productPack",
  "goodsReceipt",
  "inventoryAdjustment",
  "inventoryBalance",
  "inventoryStockThreshold",
  "stocktake",
  "stocktakeLine",
];
const BANNED_PROTECTED_MUTATIONS = [
  ...(PROTECTED_MODEL_DELEGATES.length === 0
    ? []
    : [
        {
          selector: `CallExpression[callee.property.name=/^(update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)$/][callee.object.property.name=/^(${PROTECTED_MODEL_DELEGATES.join("|")})$/]`,
          message: "Protected (append-only) models are never updated or deleted. Record a correction as a new row.",
        },
      ]),
  ...(NO_DELETE_MODEL_DELEGATES.length === 0
    ? []
    : [
        {
          selector: `CallExpression[callee.property.name=/^(delete|deleteMany)$/][callee.object.property.name=/^(${NO_DELETE_MODEL_DELEGATES.join("|")})$/]`,
          message: "These records are never hard-deleted. Change their status through an audited use case.",
        },
      ]),
];
const BANNED_RAW_SQL = [
  {
    selector: "MemberExpression[property.name=/^\\$(queryRawUnsafe|executeRawUnsafe)$/]",
    message: "Unsafe raw SQL is banned (ADR-002 section 19). Use parameterized queries.",
  },
];

/**
 * Cognito groups and custom attributes are never authorization input (ADR-003
 * section 8, ADR-005); only tests may name them, to prove they are ignored.
 */
const BANNED_IDENTITY_CLAIMS = [
  {
    selector: "Literal[value=/^(cognito|custom):/]",
    message: "Cognito groups and custom claims are never read: Tali authorizes from its database (ADR-003).",
  },
  {
    selector: "TemplateElement[value.raw=/^(cognito|custom):/]",
    message: "Cognito groups and custom claims are never read: Tali authorizes from its database (ADR-003).",
  },
];

const DETERMINISM_SYNTAX = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: "Read the current time through the Clock port, not new Date().",
  },
];

const DETERMINISM_PROPERTIES = [
  {
    object: "Math",
    property: "random",
    message: "Math.random is insecure and non-deterministic (ADR-002 section 14).",
  },
  { object: "Date", property: "now", message: "Read the current time through the Clock port." },
  {
    object: "Number",
    property: "parseFloat",
    message: "Floating-point parsing is not allowed for authoritative values.",
  },
];

/**
 * @param {{ tsconfigRootDir: string }} options
 */
export function createConfig({ tsconfigRootDir }) {
  return defineConfig(
    {
      ignores: [
        "**/node_modules/**",
        "**/dist/**",
        "**/coverage/**",
        "**/.turbo/**",
        "**/generated/**",
        "**/.next/**",
        "**/next-env.d.ts",
        "**/.expo/**",
        "apps/mobile/android/**",
        "apps/mobile/ios/**",
        "**/playwright-report/**",
        "**/test-results/**",
      ],
    },
    js.configs.recommended,
    {
      files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
      languageOptions: { globals: { ...globals.node } },
    },
    {
      files: ["**/*.cjs"],
      languageOptions: { sourceType: "commonjs" },
    },
    {
      files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
      extends: [tseslint.configs.strictTypeChecked],
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        // Async port implementations without await are intentional: throws become rejections.
        "@typescript-eslint/require-await": "off",
        "@typescript-eslint/consistent-type-imports": "error",
        "@typescript-eslint/switch-exhaustiveness-check": "error",
        "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      },
    },
    {
      files: ["**/*.{ts,tsx,mts,cts,mjs,cjs,js}"],
      rules: {
        "no-restricted-imports": restrictedImports([]),
        "no-restricted-syntax": ["error", ...BANNED_RAW_SQL, ...BANNED_IDENTITY_CLAIMS],
      },
    },
    {
      files: ["packages/domain/**/*.ts"],
      rules: {
        "no-restricted-imports": restrictedImports([
          ...FRAMEWORK_AND_INFRA_BANS,
          ...NODE_BUILTIN_BANS,
          workspaceBan(["@tali/"], "packages/domain depends on no other workspace package."),
          workspaceBan(["zod"], "packages/domain is dependency-free; validation lives at the edges."),
        ]),
        "no-restricted-syntax": ["error", ...BANNED_RAW_SQL, ...BANNED_IDENTITY_CLAIMS, ...DETERMINISM_SYNTAX],
        "no-restricted-properties": ["error", ...DETERMINISM_PROPERTIES],
        "no-restricted-globals": ["error", { name: "parseFloat", message: "No floating-point parsing in the domain." }],
      },
    },
    {
      files: ["packages/domain/src/kernel/**/*.ts"],
      rules: {
        "no-restricted-imports": restrictedImports([
          ...FRAMEWORK_AND_INFRA_BANS,
          ...NODE_BUILTIN_BANS,
          workspaceBan(["@tali/"], "packages/domain depends on no other workspace package."),
          workspaceBan(["zod"], "packages/domain is dependency-free; validation lives at the edges."),
          { regex: "(^|/)modules(/|$)", message: "The client-safe kernel may not import domain/modules/**." },
        ]),
      },
    },
    {
      files: ["packages/application/**/*.ts"],
      rules: {
        "no-restricted-imports": restrictedImports([
          ...FRAMEWORK_AND_INFRA_BANS,
          ...NODE_BUILTIN_BANS,
          workspaceBan(
            ["@tali/shared", "@tali/config"],
            "packages/application may not depend on shared wire contracts or config (ADR-002 section 6).",
          ),
          workspaceBan(
            ["@tali/database", "@tali/integrations", "@tali/ai", "@tali/ui"],
            "packages/application defines ports; adapters depend on it, never the reverse.",
          ),
        ]),
        "no-restricted-syntax": ["error", ...BANNED_RAW_SQL, ...BANNED_IDENTITY_CLAIMS, ...DETERMINISM_SYNTAX],
        "no-restricted-properties": ["error", ...DETERMINISM_PROPERTIES],
      },
    },
    {
      files: ["packages/shared/**/*.ts"],
      rules: {
        "no-restricted-imports": restrictedImports([
          ...FRAMEWORK_AND_INFRA_BANS,
          ...NODE_BUILTIN_BANS,
          workspaceBan(["@tali/"], "packages/shared contains wire contracts only and depends on no workspace package."),
        ]),
      },
    },
    {
      files: ["packages/database/**/*.ts"],
      rules: {
        "no-restricted-imports": restrictedImports(
          [
            workspaceBan(
              ["@tali/integrations", "@tali/shared", "@tali/ai", "@tali/ui", "@tali/api", "@tali/worker"],
              "packages/database depends only on application and domain (ADR-002 section 6).",
            ),
            { regex: specifiers(["@nestjs/", "express"]), message: "packages/database is framework-free." },
          ],
          DATABASE_VENDOR_BANS,
        ),
        "no-restricted-syntax": ["error", ...BANNED_RAW_SQL, ...BANNED_IDENTITY_CLAIMS, ...BANNED_PROTECTED_MUTATIONS],
      },
    },
    {
      files: ["packages/integrations/**/*.ts"],
      rules: {
        "no-restricted-imports": restrictedImports(INTEGRATIONS_BANS, INTEGRATIONS_VENDOR_BANS),
      },
    },
    {
      files: ["packages/integrations/src/local/**/*.ts"],
      rules: {
        "no-restricted-imports": restrictedImports(
          [
            ...INTEGRATIONS_BANS,
            {
              regex: specifiers(["fs", "fs/promises", "node:fs", "node:fs/promises"]),
              message:
                "The local signing key is generated per process and never persisted or loaded (ADR-005 section 16).",
            },
          ],
          INTEGRATIONS_VENDOR_BANS,
        ),
      },
    },
    {
      files: ["packages/config/**/*.ts"],
      rules: {
        "no-restricted-imports": restrictedImports([
          ...FRAMEWORK_AND_INFRA_BANS,
          workspaceBan(["@tali/"], "packages/config depends on no workspace package."),
        ]),
      },
    },
    {
      files: ["apps/api/**/*.ts"],
      rules: {
        ...NEST_CLASS_RULES,
        "no-restricted-imports": restrictedImports([...APP_PERSISTENCE_BANS, ...API_WORKSPACE_BANS], APP_VENDOR_BANS),
      },
    },
    {
      files: ["apps/api/src/**/*.controller.ts"],
      rules: {
        "no-restricted-imports": restrictedImports(
          [...APP_PERSISTENCE_BANS, ...API_WORKSPACE_BANS, ...CONTROLLER_BANS],
          APP_VENDOR_BANS,
        ),
      },
    },
    {
      files: ["apps/worker/**/*.ts"],
      rules: {
        ...NEST_CLASS_RULES,
        "no-restricted-imports": restrictedImports(
          [...APP_PERSISTENCE_BANS, ...WORKER_WORKSPACE_BANS],
          APP_VENDOR_BANS,
        ),
      },
    },
    {
      files: ["apps/worker/src/handlers/**/*.ts"],
      rules: {
        "no-restricted-imports": restrictedImports(
          [...APP_PERSISTENCE_BANS, ...WORKER_WORKSPACE_BANS, ...HANDLER_BANS],
          APP_VENDOR_BANS,
        ),
      },
    },
    {
      files: ["apps/web/**/*.{ts,tsx,mjs,js}", "apps/mobile/**/*.{ts,tsx,mjs,js}"],
      rules: {
        "no-restricted-imports": restrictedImports(CLIENT_BANS),
      },
    },
    {
      files: ["apps/web/src/**/*.{ts,tsx}", "apps/mobile/src/**/*.{ts,tsx}", "apps/mobile/app/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": restrictedImports([...CLIENT_BANS, ...CLIENT_RUNTIME_BANS]),
      },
    },
    {
      files: ["apps/web/src/lib/auth/cognito/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": restrictedImports(
          [...CLIENT_BANS, ...CLIENT_RUNTIME_BANS],
          CLIENT_COGNITO_VENDOR_BANS,
        ),
      },
    },
    {
      files: ["apps/mobile/**/*.{ts,tsx,mjs,js}"],
      rules: {
        "no-restricted-imports": restrictedImports([...CLIENT_BANS, ...MOBILE_AMPLIFY_PEER_BANS]),
      },
    },
    {
      files: ["apps/mobile/src/**/*.{ts,tsx}", "apps/mobile/app/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": restrictedImports([
          ...CLIENT_BANS,
          ...CLIENT_RUNTIME_BANS,
          ...MOBILE_AMPLIFY_PEER_BANS,
        ]),
      },
    },
    {
      // The single initialization boundary of ADR-007 section 6.3, and the one test that spies on its order.
      files: ["apps/mobile/src/auth/cognito/amplify-cognito-auth.ts", "apps/mobile/test/amplify-init-order.test.ts"],
      rules: {
        "no-restricted-imports": restrictedImports(
          [...CLIENT_BANS, ...CLIENT_RUNTIME_BANS, ...MOBILE_AMPLIFY_PEER_BANS],
          CLIENT_COGNITO_VENDOR_BANS,
        ),
      },
    },
    {
      // Tests prove groups and custom claims are ignored, so they may name them.
      files: ["**/*.test.{ts,tsx}", "apps/*/test/**/*.ts", "apps/web/e2e/**/*.ts", "apps/web/e2e-cognito/**/*.ts"],
      ignores: ["packages/domain/**", "packages/application/**", "packages/database/**"],
      rules: {
        "no-restricted-syntax": ["error", ...BANNED_RAW_SQL],
      },
    },
  );
}
