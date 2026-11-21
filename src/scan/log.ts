/** Logging levels from PRD §19, ordered least to most verbose. */
export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  trace(message: string): void;
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** A logger that discards everything. The default inside library code. */
export const silentLogger: Logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
};

/**
 * Level-filtered logger. Reports go to stdout, so log lines go to stderr and
 * never contaminate `--format json`.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const at = (l: LogLevel) => LOG_LEVELS.indexOf(l) <= threshold;
  const emit = (l: LogLevel, message: string) => {
    if (at(l)) write(`[${l.toUpperCase()}] ${message}`);
  };
  return {
    error: (m) => emit("error", m),
    warn: (m) => emit("warn", m),
    info: (m) => emit("info", m),
    debug: (m) => emit("debug", m),
    trace: (m) => emit("trace", m),
  };
}
