// @ts-check
/**
 * Two projects on the jest-expo preset (Expo's Babel pipeline, React Native
 * test environment). This is Node.js, not Hermes: engine compatibility is
 * proven on a Hermes release build (docs/audits/bigint-hermes-compatibility.md).
 * - mobile: the app's own tests.
 * - kernel-expo-babel: the unchanged @tali/domain kernel suites compiled by
 *   babel-preset-expo, proving the Expo transform keeps bigint semantics.
 */
const TRANSFORM_IGNORE = [
  // jest-expo's default list, plus uuid (ESM-only). Under pnpm the package path repeats /node_modules/<name>.
  "/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|uuid))",
  "/node_modules/react-native-reanimated/plugin/",
  "/node_modules/@react-native/babel-preset/",
];

/** @type {import("jest").Config} */
module.exports = {
  projects: [
    {
      displayName: "mobile",
      preset: "jest-expo",
      rootDir: __dirname,
      testMatch: ["<rootDir>/test/**/*.test.{ts,tsx}"],
      transformIgnorePatterns: TRANSFORM_IGNORE,
    },
    {
      displayName: "kernel-expo-babel",
      preset: "jest-expo",
      rootDir: __dirname,
      roots: ["<rootDir>/../../packages/domain/src/kernel"],
      testMatch: ["**/*.test.ts"],
      // surface.test.ts pins the package export map (a JSON import attribute), not runtime behaviour.
      testPathIgnorePatterns: ["surface\\.test\\.ts$"],
      moduleNameMapper: {
        "^vitest$": "<rootDir>/test/support/vitest-as-jest.ts",
        "^(\\.{1,2}/.*)\\.js$": "$1",
      },
      transformIgnorePatterns: TRANSFORM_IGNORE,
    },
  ],
};
