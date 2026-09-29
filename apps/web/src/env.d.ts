// The only environment variables the web app reads: public configuration,
// inlined into the client bundle by Next.js (validated by @tali/config/public).
declare namespace NodeJS {
  interface ProcessEnv {
    readonly NEXT_PUBLIC_TALI_ENV?: string;
    readonly NEXT_PUBLIC_API_BASE_URL?: string;
    readonly NEXT_PUBLIC_COGNITO_REGION?: string;
    readonly NEXT_PUBLIC_COGNITO_USER_POOL_ID?: string;
    readonly NEXT_PUBLIC_COGNITO_CLIENT_ID?: string;
  }
}
