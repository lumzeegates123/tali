import type { LoggerService } from "@nestjs/common";
import { currentCorrelationId } from "./correlation-context.js";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const SEVERITY: Record<LogLevel, number> = { fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10 };

/** Field names whose values are never written to logs. */
// Plan 003 section 11: JWTs, bearer values, keys, claims, provider subjects, display names and contact details too.
const REDACTED_FIELD =
  /pass(word)?|secret|token|authorization|cookie|credential|api[-_]?key|database_?url|connection_?string|jwt|bearer|private[-_]?key|signature|claims?$|subject|display[-_]?name|e[-_]?mail|phone/i;

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
}

export type LogSink = (line: string) => void;

const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_STACK_FRAMES = 30;

/**
 * An error as logged: name, a bounded `code` and the stack frames. Never the
 * message: persistence, JWT and parser errors quote request data there (query
 * arguments, display names, subjects, raw bodies), and the stack's first line
 * repeats it.
 */
function serializeError(error: Error, depth: number): Record<string, unknown> {
  const code: unknown = (error as { code?: unknown }).code;
  const frames = (error.stack ?? "")
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(0, MAX_STACK_FRAMES)
    .map((line) => line.trim());
  return {
    name: error.name,
    ...(typeof code === "string" && ERROR_CODE.test(code) ? { code } : {}),
    ...(frames.length === 0 ? {} : { stack: frames }),
    ...(error.cause instanceof Error && depth < 3 ? { cause: serializeError(error.cause, depth + 1) } : {}),
  };
}

function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return serializeError(value, 0);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      REDACTED_FIELD.test(key) ? "[REDACTED]" : redact(item, depth + 1),
    ]),
  );
}

/**
 * Structured JSON logger: one JSON object per line on stdout, stamped with the
 * service name and the current correlation ID. Values under secret-like field
 * names are redacted.
 */
export class JsonLogger implements Logger {
  readonly #service: string;
  readonly #threshold: number;
  readonly #sink: LogSink;

  constructor(options: { readonly service: string; readonly level: LogLevel; readonly sink?: LogSink }) {
    this.#service = options.service;
    this.#threshold = SEVERITY[options.level];
    this.#sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  }

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (SEVERITY[level] < this.#threshold) return;
    const correlationId = currentCorrelationId();
    const entry = {
      time: new Date().toISOString(),
      level,
      service: this.#service,
      msg: message,
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(redact(fields) as Record<string, unknown>),
    };
    this.#sink(JSON.stringify(entry));
  }

  error(message: string, fields?: LogFields): void {
    this.log("error", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.log("warn", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.log("info", message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.log("debug", message, fields);
  }
}

/** Routes NestJS framework logs through the structured logger. */
export class NestLoggerAdapter implements LoggerService {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.#logger.info(String(message), { context: rest.at(-1) });
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.#logger.error(String(message), { context: rest.at(-1), detail: rest.length > 1 ? rest[0] : undefined });
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.#logger.warn(String(message), { context: rest.at(-1) });
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.#logger.debug(String(message), { context: rest.at(-1) });
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.#logger.log("trace", String(message), { context: rest.at(-1) });
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.#logger.log("fatal", String(message), { context: rest.at(-1) });
  }
}
