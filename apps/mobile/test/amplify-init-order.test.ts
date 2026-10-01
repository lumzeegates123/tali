import type * as CognitoDevice from "./support/cognito-device";
import type * as AmplifyAuth from "aws-amplify/auth";
import type * as AmplifyCognito from "aws-amplify/auth/cognito";
import type * as AmplifyRoot from "aws-amplify";
import type * as AuthModule from "../src/auth/cognito/amplify-cognito-auth";
import type * as SecureCognitoStorageModule from "../src/auth/cognito/secure-cognito-storage";
import type { AmplifyCognitoAuth } from "../src/auth/cognito/amplify-cognito-auth";
import { asyncStorageWrites, device, installNativeSrpDouble, resetDevice } from "./support/cognito-device";
import {
  FAKE_COGNITO_CLIENT_ID,
  FAKE_COGNITO_REGION,
  FAKE_COGNITO_USER_POOL_ID,
  FakeCognito,
} from "./support/fake-cognito";

/*
 * ADR-007 section 6.3. The only test that reaches Amplify other than through
 * the boundary module: it spies on the initialization order and shows the
 * AsyncStorage detector works.
 */

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof CognitoDevice>("./support/cognito-device").secureStoreMock(),
);
jest.mock("expo-crypto", () => jest.requireActual<typeof CognitoDevice>("./support/cognito-device").expoCryptoMock());
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual<typeof CognitoDevice>("./support/cognito-device").asyncStorageMock(),
);

const CONFIG = { region: FAKE_COGNITO_REGION, userPoolId: FAKE_COGNITO_USER_POOL_ID, clientId: FAKE_COGNITO_CLIENT_ID };
const EMAIL = "pilot.owner@example.test";
const PASSWORD = "Passpass-1111";

let cognito: FakeCognito;

function boot(): AmplifyCognitoAuth {
  installNativeSrpDouble();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AmplifyCognitoAuth: Auth } = require("../src/auth/cognito/amplify-cognito-auth") as typeof AuthModule;
  return Auth.configure(CONFIG);
}

const cognitoItems = () => [...device().secure.entries()].filter(([key]) => key.startsWith("tali.cognito.v1."));

beforeEach(() => {
  resetDevice();
  jest.resetModules();
  cognito = new FakeCognito();
  globalThis.fetch = cognito.fetch;
});

afterEach(() => {
  expect(asyncStorageWrites()).toEqual([]);
  expect(device().asyncStorageCalls).toEqual([]);
  expect(cognito.refusedHosts).toEqual([]);
});

describe("initialization order (ADR-007 section 6.3)", () => {
  it("installs a Tali adapter on the token provider before Amplify.configure, and hands that provider to it", async () => {
    installNativeSrpDouble();
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { Amplify } = require("aws-amplify") as typeof AmplifyRoot;
    const { cognitoUserPoolsTokenProvider } = require("aws-amplify/auth/cognito") as typeof AmplifyCognito;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const setAuthConfig = jest.spyOn(cognitoUserPoolsTokenProvider, "setAuthConfig");
    const setStorage = jest.spyOn(cognitoUserPoolsTokenProvider, "setKeyValueStorage");
    const configure = jest.spyOn(Amplify, "configure");
    boot();
    expect(setAuthConfig).toHaveBeenCalledTimes(1);
    expect(setStorage).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledTimes(1);
    // Reversing this order (configure first) would let Amplify select its default persistent store.
    const [authConfigAt] = setAuthConfig.mock.invocationCallOrder;
    const [storageAt] = setStorage.mock.invocationCallOrder;
    const [configureAt] = configure.mock.invocationCallOrder;
    expect(authConfigAt).toBeLessThan(storageAt ?? 0);
    expect(storageAt).toBeLessThan(configureAt ?? 0);
    // The process-wide provider's adapter keeps nothing: sessions run in their own contexts.
    const [installed] = setStorage.mock.calls[0] ?? [];
    expect(Object.keys(installed ?? {}).sort()).toEqual(["clear", "getItem", "removeItem", "setItem"]);
    await installed?.setItem("k", "v");
    expect(await installed?.getItem("k")).toBeNull();
    expect(device().secure.size).toBe(0);
    const [resources, libraryOptions] = configure.mock.calls[0] ?? [];
    expect(libraryOptions?.Auth?.tokenProvider).toBe(cognitoUserPoolsTokenProvider);
    expect(libraryOptions?.Auth?.credentialsProvider).toBeUndefined();
    expect(resources).toEqual({
      Auth: {
        Cognito: {
          userPoolId: FAKE_COGNITO_USER_POOL_ID,
          userPoolClientId: FAKE_COGNITO_CLIENT_ID,
          loginWith: { email: true },
          signUpVerificationMethod: "code",
        },
      },
    });
  });

  it("configures once per runtime", () => {
    expect(boot()).toBe(boot());
  });

  it("the first storage access of a session goes to the Tali SecureStore namespace", async () => {
    const auth = boot();
    expect(device().secureCalls).toEqual([]);
    expect(await auth.restore()).toEqual({ status: "none" });
    expect(device().secureCalls[0]?.key).toMatch(/^tali\.cognito\.v1\./u);
    const result = await auth.signIn(EMAIL, PASSWORD);
    expect(result.status).toBe("signedIn");
    expect(cognitoItems().length).toBeGreaterThan(0);
  });

  it("would detect Amplify's default storage: configured without Tali storage, sign-in writes to AsyncStorage", async () => {
    // The detector check for every other test that asserts nothing reaches AsyncStorage. Not how the app configures Amplify.
    installNativeSrpDouble();
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { Amplify } = require("aws-amplify") as typeof AmplifyRoot;
    const auth = require("aws-amplify/auth") as typeof AmplifyAuth;
    /* eslint-enable @typescript-eslint/no-require-imports */
    Amplify.configure({
      Auth: { Cognito: { userPoolId: FAKE_COGNITO_USER_POOL_ID, userPoolClientId: FAKE_COGNITO_CLIENT_ID } },
    });
    // The recording AsyncStorage stores nothing, so Amplify's post-sign-in read fails after its writes.
    await auth.signIn({ username: EMAIL, password: PASSWORD }).catch(() => undefined);
    expect(asyncStorageWrites().map((call) => call.op)).toContain("setItem");
    expect(JSON.stringify(asyncStorageWrites())).toContain(cognito.issued.refresh[0] ?? "missing");
    expect(cognitoItems()).toEqual([]);
    device().asyncStorageCalls.length = 0;
  });

  it("reversed order regression: configuring first lets Amplify reach AsyncStorage before Tali storage exists", async () => {
    installNativeSrpDouble();
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { Amplify } = require("aws-amplify") as typeof AmplifyRoot;
    const auth = require("aws-amplify/auth") as typeof AmplifyAuth;
    const { cognitoUserPoolsTokenProvider } = require("aws-amplify/auth/cognito") as typeof AmplifyCognito;
    const { createSecureCognitoStorage } =
      require("../src/auth/cognito/secure-cognito-storage") as typeof SecureCognitoStorageModule;
    /* eslint-enable @typescript-eslint/no-require-imports */
    Amplify.configure({
      Auth: { Cognito: { userPoolId: FAKE_COGNITO_USER_POOL_ID, userPoolClientId: FAKE_COGNITO_CLIENT_ID } },
    });
    await auth.fetchAuthSession().catch(() => undefined);
    cognitoUserPoolsTokenProvider.setKeyValueStorage(createSecureCognitoStorage());
    expect(device().asyncStorageCalls.length).toBeGreaterThan(0);
    device().asyncStorageCalls.length = 0;
  });
});
