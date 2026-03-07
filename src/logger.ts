export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(level: LogLevel): Logger {
  const minWeight = LEVEL_WEIGHT[level];

  function write(entryLevel: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[entryLevel] < minWeight) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level: entryLevel,
      message,
      ...(fields ?? {})
    };

    const line = JSON.stringify(payload);
    if (entryLevel === "error" || entryLevel === "warn") {
      process.stderr.write(`${line}\n`);
      return;
    }

    process.stdout.write(`${line}\n`);
  }

  return {
    debug(message, fields) {
      write("debug", message, fields);
    },
    info(message, fields) {
      write("info", message, fields);
    },
    warn(message, fields) {
      write("warn", message, fields);
    },
    error(message, fields) {
      write("error", message, fields);
    }
  };
}
