/**
 * Injection tokens. Every constructor dependency is injected with an explicit
 * token (`@Inject(TOKEN)`): the apps compile without emitDecoratorMetadata, so
 * tests (Vite/Oxc) and the tsc build resolve dependencies identically.
 */
export const SERVER_CONFIG = Symbol("SERVER_CONFIG");
export const LOGGER = Symbol("LOGGER");
export const CLOCK = Symbol("CLOCK");
export const QUEUE_PROVIDER = Symbol("QUEUE_PROVIDER");
export const MESSAGE_HANDLERS = Symbol("MESSAGE_HANDLERS");
export const HEARTBEAT = Symbol("HEARTBEAT");
