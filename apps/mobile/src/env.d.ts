declare namespace NodeJS {
  interface ProcessEnv {
    readonly EXPO_PUBLIC_TALI_ENV?: string;
    readonly EXPO_PUBLIC_API_BASE_URL?: string;
    readonly EXPO_PUBLIC_AUTH_MODE?: string;
    readonly EXPO_PUBLIC_COGNITO_REGION?: string;
    readonly EXPO_PUBLIC_COGNITO_USER_POOL_ID?: string;
    readonly EXPO_PUBLIC_COGNITO_CLIENT_ID?: string;
  }
}
