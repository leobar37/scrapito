/** Minimal structured logger. Levels gate on SCRAP_LOG_LEVEL (default info). */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

class JsonLogger implements Logger {
  constructor(
    private readonly threshold: number,
    private readonly bindings: Record<string, unknown>,
    private readonly sink: (line: string) => void,
  ) {}

  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger(
      this.threshold,
      { ...this.bindings, ...bindings },
      this.sink,
    );
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.bindings,
      ...fields,
    };
    this.sink(JSON.stringify(record));
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit("error", msg, fields);
  }
}

export function createLogger(
  level: LogLevel = (process.env.SCRAP_LOG_LEVEL as LogLevel) || "info",
  sink: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): Logger {
  return new JsonLogger(LEVEL_ORDER[level] ?? LEVEL_ORDER.info, {}, sink);
}

/** A logger that discards everything, for tests. */
export const nullLogger: Logger = {
  child: () => nullLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
