/**
 * Injection tokens. Every constructor dependency is injected with an explicit
 * token (`@Inject(TOKEN)`): the apps compile without emitDecoratorMetadata, so
 * tests (Vite/Oxc) and the tsc build resolve dependencies identically.
 */
export const SERVER_CONFIG = Symbol("SERVER_CONFIG");
export const LOGGER = Symbol("LOGGER");
export const CLOCK = Symbol("CLOCK");
export const DATABASE_HEALTH = Symbol("DATABASE_HEALTH");
export const IDENTITY_PROVIDER = Symbol("IDENTITY_PROVIDER");
export const API_RUNTIME = Symbol("API_RUNTIME");
export const API_SERVICES = Symbol("API_SERVICES");
export const LOCAL_SIGN_IN = Symbol("LOCAL_SIGN_IN");
export const INVITATION_ACCEPT_LIMITER = Symbol("INVITATION_ACCEPT_LIMITER");
