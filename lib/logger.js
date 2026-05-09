// ═══════════════════════════════════════════════════════════════════════════
// lib/logger.js
// Lightweight structured logger. Drop-in replacement for console.log calls.
// In production swap with pino/winston without changing call sites.
// ═══════════════════════════════════════════════════════════════════════════

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT_LEVEL =
  LEVELS[process.env.LOG_LEVEL?.toLowerCase()] || LEVELS.info;

const format = (level, scope, message, meta) => {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [${level.toUpperCase()}] [${scope}] ${message}`;
  return meta ? `${base} ${JSON.stringify(meta)}` : base;
};

const log = (level, scope, message, meta) => {
  if (LEVELS[level] < CURRENT_LEVEL) return;
  const formatted = format(level, scope, message, meta);
  if (level === "error") console.error(formatted);
  else if (level === "warn") console.warn(formatted);
  else console.log(formatted);
};

export const createLogger = (scope) => ({
  debug: (message, meta) => log("debug", scope, message, meta),
  info: (message, meta) => log("info", scope, message, meta),
  warn: (message, meta) => log("warn", scope, message, meta),
  error: (message, meta) => log("error", scope, message, meta),
});

export default createLogger;
