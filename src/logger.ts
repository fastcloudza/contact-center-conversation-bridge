type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(minLevel: Level) {
  const log = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const line = { time: new Date().toISOString(), level, msg, ...fields };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  };

  return {
    debug: (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
  };
}

export type Logger = ReturnType<typeof createLogger>;
