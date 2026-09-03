import { LOG_LEVELS } from "../utils/logging.js";
import type { LogLevel } from "../utils/logging.js";

export const SUPPORTED_BROWSERS = ["chrome", "chromium", "edge"] as const;

export type BrowserName = (typeof SUPPORTED_BROWSERS)[number];
export type ConnectionMode = "launch" | "existing-cdp";
export type Environment = Readonly<Record<string, string | undefined>>;

export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Validated runtime configuration.
 *
 * A configured browser is an explicit request, not a preference. Browser
 * discovery must reject startup if that browser is unavailable instead of
 * silently selecting another installed browser.
 */
export interface BrowserConfig {
  /** Undefined means use deterministic auto-discovery. */
  readonly browser: BrowserName | undefined;
  readonly executablePath: string | undefined;
  readonly cdpEndpoint: string | undefined;
  readonly connectionMode: ConnectionMode;
  readonly headless: boolean;
  readonly userDataDir: string | undefined;
  readonly useUserProfile: boolean;
  readonly downloadDir: string | undefined;
  readonly startupTimeoutMs: number;
  readonly defaultTimeoutMs: number;
  readonly logLevel: LogLevel;
}

export class ConfigError extends Error {
  public constructor(
    public readonly variable: string,
    message: string,
  ) {
    super(`${variable}: ${message}`);
    this.name = "ConfigError";
  }
}

function optionalValue(environment: Environment, variable: string): string | undefined {
  const value = environment[variable]?.trim();
  return value === "" || value === undefined ? undefined : value;
}

function parseBrowser(environment: Environment): BrowserName | undefined {
  const value = optionalValue(environment, "BROWSER")?.toLowerCase();
  if (value === undefined) {
    return undefined;
  }

  if ((SUPPORTED_BROWSERS as readonly string[]).includes(value)) {
    return value as BrowserName;
  }

  throw new ConfigError(
    "BROWSER",
    `must be one of: ${SUPPORTED_BROWSERS.join(", ")}. Received ${JSON.stringify(value)}.`,
  );
}

function parseBoolean(
  environment: Environment,
  variable: string,
  defaultValue: boolean,
): boolean {
  const value = optionalValue(environment, variable)?.toLowerCase();
  if (value === undefined) {
    return defaultValue;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new ConfigError(variable, 'must be "true" or "false".');
}

function parsePositiveInteger(
  environment: Environment,
  variable: string,
  defaultValue: number,
): number {
  const value = optionalValue(environment, variable);
  if (value === undefined) {
    return defaultValue;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new ConfigError(variable, "must be a positive integer in milliseconds.");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigError(variable, "must be a safe positive integer in milliseconds.");
  }

  return parsed;
}

function parseCdpEndpoint(environment: Environment): string | undefined {
  const endpoint = optionalValue(environment, "BROWSER_CDP_ENDPOINT");
  if (endpoint === undefined) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ConfigError(
      "BROWSER_CDP_ENDPOINT",
      "must be a valid http(s) URL, for example http://127.0.0.1:9222.",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      "BROWSER_CDP_ENDPOINT",
      "must use the http: or https: protocol.",
    );
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new ConfigError(
      "BROWSER_CDP_ENDPOINT",
      "must not contain credentials.",
    );
  }

  return parsed.toString();
}

function parseLogLevel(environment: Environment): LogLevel {
  const value = optionalValue(environment, "BROWSER_MCP_LOG_LEVEL")?.toLowerCase();
  if (value === undefined) {
    return "info";
  }

  if ((LOG_LEVELS as readonly string[]).includes(value)) {
    return value as LogLevel;
  }

  throw new ConfigError(
    "BROWSER_MCP_LOG_LEVEL",
    `must be one of: ${LOG_LEVELS.join(", ")}. Received ${JSON.stringify(value)}.`,
  );
}

/**
 * Load and validate all supported environment variables without performing
 * filesystem or network access. Browser availability is deliberately checked
 * later by the browser discovery layer, where useful searched-path diagnostics
 * can be returned.
 */
export function loadConfig(environment: Environment = process.env): BrowserConfig {
  const cdpEndpoint = parseCdpEndpoint(environment);

  return {
    browser: parseBrowser(environment),
    executablePath: optionalValue(environment, "BROWSER_EXECUTABLE"),
    cdpEndpoint,
    connectionMode: cdpEndpoint === undefined ? "launch" : "existing-cdp",
    headless: parseBoolean(environment, "BROWSER_HEADLESS", false),
    userDataDir: optionalValue(environment, "BROWSER_USER_DATA_DIR"),
    useUserProfile: parseBoolean(environment, "BROWSER_USE_USER_PROFILE", true),
    downloadDir: optionalValue(environment, "BROWSER_DOWNLOAD_DIR"),
    startupTimeoutMs: parsePositiveInteger(
      environment,
      "BROWSER_STARTUP_TIMEOUT",
      DEFAULT_STARTUP_TIMEOUT_MS,
    ),
    defaultTimeoutMs: parsePositiveInteger(
      environment,
      "BROWSER_DEFAULT_TIMEOUT",
      DEFAULT_TIMEOUT_MS,
    ),
    logLevel: parseLogLevel(environment),
  };
}
