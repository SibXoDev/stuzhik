/**
 * Global console interceptor for DevConsole
 * MUST be imported FIRST in index.tsx to catch all logs
 */

export interface LogEntry {
  timestamp: string;
  level: string;
  target: string;
  message: string;
  source?: "rust" | "ts";
}

// Global TS log buffer - ALWAYS collects logs (even when console is closed)
export const tsLogBuffer: LogEntry[] = [];
const MAX_BUFFER_SIZE = 1000;
export let tsLogListeners: ((entry: LogEntry) => void)[] = [];

// Setup console interception ONCE at module load
let interceptorSetup = false;

export function setupGlobalInterceptor() {
  if (interceptorSetup) return;
  interceptorSetup = true;

  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const createInterceptor = (level: string, original: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      // Call original first
      original(...args);

      const entry: LogEntry = {
        timestamp: new Date().toISOString().replace("T", " ").slice(0, -1),
        level: level.toUpperCase(),
        target: "frontend",
        message: args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "),
        source: "ts",
      };

      // Add to buffer
      tsLogBuffer.push(entry);
      if (tsLogBuffer.length > MAX_BUFFER_SIZE) {
        tsLogBuffer.shift();
      }

      // Notify listeners (if console is open)
      tsLogListeners.forEach(fn => fn(entry));
    };
  };

  console.log = createInterceptor("info", originalConsole.log);
  console.info = createInterceptor("info", originalConsole.info);
  console.warn = createInterceptor("warn", originalConsole.warn);
  console.error = createInterceptor("error", originalConsole.error);
  console.debug = createInterceptor("debug", originalConsole.debug);
}

// Initialize interceptor IMMEDIATELY when this module loads
setupGlobalInterceptor();
