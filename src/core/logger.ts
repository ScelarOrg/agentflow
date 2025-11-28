/**
 * Configurable logger for AgentFlow
 * Debug logs are disabled by default in production
 */

// Declare process for environments that have it (Node.js)
declare const process: { env: Record<string, string | undefined> } | undefined;

type LogLevel = "debug" | "info" | "warn" | "error" | "none";

interface LoggerConfig {
  level: LogLevel;
  prefix: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

// Safely get environment variables (works in Node.js, browser, and edge runtimes)
function getEnvVar(name: string): string | undefined {
  if (typeof process !== "undefined" && process.env) {
    return process.env[name];
  }
  return undefined;
}

let config: LoggerConfig = {
  level:
    (getEnvVar("AGENTFLOW_LOG_LEVEL") as LogLevel) ||
    (getEnvVar("NODE_ENV") === "development" ? "debug" : "error"),
  prefix: "[AgentFlow]",
};

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[config.level];
}

export const logger = {
  /**
   * Configure the logger
   */
  configure(options: Partial<LoggerConfig>) {
    config = { ...config, ...options };
  },

  /**
   * Debug level logging - only in development or when explicitly enabled
   */
  debug(...args: unknown[]) {
    if (shouldLog("debug")) {
      console.log(config.prefix, ...args);
    }
  },

  /**
   * Info level logging
   */
  info(...args: unknown[]) {
    if (shouldLog("info")) {
      console.log(config.prefix, ...args);
    }
  },

  /**
   * Warning level logging
   */
  warn(...args: unknown[]) {
    if (shouldLog("warn")) {
      console.warn(config.prefix, ...args);
    }
  },

  /**
   * Error level logging - always enabled unless level is "none"
   */
  error(...args: unknown[]) {
    if (shouldLog("error")) {
      console.error(config.prefix, ...args);
    }
  },
};
