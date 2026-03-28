import { AppConfig } from "./config.ts";

export type Logger = {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
};

function log(level: string, message: string, data?: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(data ?? {})
  };
  console.log(JSON.stringify(payload));
}

export function createLogger(level: AppConfig["LOG_LEVEL"]): Logger {
  const order: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = order[level] ?? 20;

  const allow = (lvl: string): boolean => (order[lvl] ?? 100) >= min;

  return {
    debug: (message, data) => {
      if (allow("debug")) log("debug", message, data);
    },
    info: (message, data) => {
      if (allow("info")) log("info", message, data);
    },
    warn: (message, data) => {
      if (allow("warn")) log("warn", message, data);
    },
    error: (message, data) => {
      if (allow("error")) log("error", message, data);
    }
  };
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  operation: string,
  attempts: number,
  baseDelaySeconds: number,
  fn: () => Promise<T>,
  logger: Logger
): Promise<T> {
  let lastError: unknown = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i >= attempts) break;
      const delayMs = Math.floor((baseDelaySeconds * 1000) * (2 ** (i - 1)) + Math.random() * 100);
      logger.warn("operation_retry", { operation, attempt: i, delay_ms: delayMs, error: String(error) });
      await wait(delayMs);
    }
  }

  logger.error("operation_failed", { operation, attempts, error: String(lastError) });
  throw lastError;
}

export async function hashContent(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
