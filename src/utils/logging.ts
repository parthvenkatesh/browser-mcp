/**
 * Structured logging for the process hosting the MCP server.
 *
 * stdout is deliberately never used here: the stdio MCP transport owns it for
 * JSON-RPC messages. Keeping this guarantee in one small utility makes it
 * much harder for future modules to corrupt the protocol stream accidentally.
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

const severity: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface LogRecord extends LogContext {
  timestamp: string;
  level: LogLevel;
  message: string;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

function serialize(record: LogRecord): string {
  try {
    return JSON.stringify(record, jsonReplacer);
  } catch {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "Unable to serialize a log record.",
    });
  }
}

/** Write a single structured record to stderr, never stdout. */
export function writeStderr(record: LogRecord): void {
  process.stderr.write(`${serialize(record)}\n`);
}

/**
 * Create a logger with a minimum severity. It intentionally has no stdout or
 * arbitrary stream option so application logs cannot pollute the MCP channel.
 */
export function createLogger(minimumLevel: LogLevel = "info"): Logger {
  const log = (level: LogLevel, message: string, context: LogContext = {}): void => {
    if (severity[level] < severity[minimumLevel]) {
      return;
    }

    writeStderr({
      ...context,
      timestamp: new Date().toISOString(),
      level,
      message,
    });
  };

  return {
    debug: (message, context) => log("debug", message, context),
    info: (message, context) => log("info", message, context),
    warn: (message, context) => log("warn", message, context),
    error: (message, context) => log("error", message, context),
  };
}
