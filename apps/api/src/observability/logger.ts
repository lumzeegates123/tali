import type { LoggerService } from "@nestjs/common";
import { currentCorrelationId } from "./correlation-context.js";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const SEVERITY: Record<LogLevel, number> = { fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10 };

/** Field names whose values are never written to logs. */
const REDACTED_FIELD =
  /pass(word)?|secret|token|authorization|cookie|credential|api[-_]?key|database_?url|connection_?string/i;

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
}

export type LogSink = (line: string) => void;

function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
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
