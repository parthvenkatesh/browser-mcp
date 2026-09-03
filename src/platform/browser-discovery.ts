import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { BrowserNotFoundError, type BrowserDiscoveryDiagnostics } from "../browser/errors.js";
import {
  BROWSER_DEFINITIONS,
  BROWSER_NAMES,
  inferBrowserNameFromPath,
  parseBrowserName,
  type BrowserName,
} from "./browser-definitions.js";

export type BrowserCandidateSource = "configured" | "known-path" | "path";

export interface DiscoveredBrowser {
  readonly browser: BrowserName;
  readonly executablePath: string;
  readonly source: BrowserCandidateSource;
  /** The complete ordered audit trail is useful in browser_start errors. */
  readonly checkedLocations: readonly string[];
}

export interface BrowserDiscoveryOptions {
  /** A requested browser is strict: no other installed browser is substituted. */
  readonly browser?: BrowserName | string;
  /** Explicit override, normally passed from BROWSER_EXECUTABLE. */
  readonly executablePath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
}

const DEFAULT_SEARCH_ORDER: readonly BrowserName[] = BROWSER_NAMES;

/**
 * Locate an already installed Chromium-family executable without downloading
 * or installing anything. A selected browser limits all automatic searching
 * to that browser; this makes `BROWSER=edge` deterministic and safe.
 */
export async function discoverBrowser(options: BrowserDiscoveryOptions = {}): Promise<DiscoveredBrowser> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const requestedBrowser = parseBrowserName(
    typeof options.browser === "string" ? options.browser : options.browser ?? readEnv(env, "BROWSER"),
  );
  const configuredExecutable = normalizePath(
    options.executablePath ?? readEnv(env, "BROWSER_EXECUTABLE"),
  );
  const searchedBrowsers = requestedBrowser ? [requestedBrowser] : [...DEFAULT_SEARCH_ORDER];
  const checkedLocations: string[] = [];

  if (configuredExecutable) {
    checkedLocations.push(configuredExecutable);
    if (await isExecutable(configuredExecutable, platform)) {
      return {
        browser: requestedBrowser ?? inferBrowserNameFromPath(configuredExecutable) ?? "chrome",
        executablePath: configuredExecutable,
        source: "configured",
        checkedLocations,
      };
    }

    throw browserNotFound({
      requestedBrowser,
      configuredExecutable,
      checkedLocations,
      searchedBrowsers,
    }, "The configured browser executable does not exist or is not executable.");
  }

  const pathApi = platform === "win32" ? path.win32 : path;
  for (const browser of searchedBrowsers) {
    for (const candidate of knownPaths(browser, platform, env, options.homeDir ?? homedir())) {
      const normalizedCandidate = normalizePath(candidate);
      if (!normalizedCandidate || checkedLocations.includes(normalizedCandidate)) {
        continue;
      }
      checkedLocations.push(normalizedCandidate);
      if (await isExecutable(normalizedCandidate, platform)) {
        return {
          browser,
          executablePath: normalizedCandidate,
          source: "known-path",
          checkedLocations,
        };
      }
    }

    for (const executable of BROWSER_DEFINITIONS[browser].pathExecutables) {
      for (const candidate of executableOnPath(executable, env, platform, pathApi)) {
        if (checkedLocations.includes(candidate)) {
          continue;
        }
        checkedLocations.push(candidate);
        if (await isExecutable(candidate, platform)) {
          return {
            browser,
            executablePath: candidate,
            source: "path",
            checkedLocations,
          };
        }
      }
    }
  }

  throw browserNotFound({
    requestedBrowser,
    configuredExecutable,
    checkedLocations,
    searchedBrowsers,
  });
}

export function browserDiscoveryDiagnostics(options: BrowserDiscoveryOptions = {}): BrowserDiscoveryDiagnostics {
  const env = options.env ?? process.env;
  const requestedBrowser = parseBrowserName(
    typeof options.browser === "string" ? options.browser : options.browser ?? readEnv(env, "BROWSER"),
  );
  return {
    requestedBrowser,
    configuredExecutable: normalizePath(options.executablePath ?? readEnv(env, "BROWSER_EXECUTABLE")),
    checkedLocations: [],
    searchedBrowsers: requestedBrowser ? [requestedBrowser] : [...DEFAULT_SEARCH_ORDER],
  };
}

function browserNotFound(diagnostics: BrowserDiscoveryDiagnostics, reason?: string): BrowserNotFoundError {
  return new BrowserNotFoundError(diagnostics, reason);
}

function knownPaths(
  browser: BrowserName,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): readonly string[] {
  const definition = BROWSER_DEFINITIONS[browser];
  if (platform === "darwin") {
    return definition.macosPaths.map((candidate) =>
      candidate === "~" || candidate.startsWith("~/")
        ? path.join(homeDir, candidate.slice(2))
        : candidate,
    );
  }

  if (platform === "win32") {
    return definition.windowsPaths
      .map((candidate) => expandWindowsEnvironmentVariables(candidate, env))
      .filter((candidate): candidate is string => candidate !== undefined);
  }

  // Linux is not a formally supported target, but PATH discovery is still
  // useful for developers and CI. Avoid fabricating OS-specific paths here.
  return [];
}

function expandWindowsEnvironmentVariables(template: string, env: NodeJS.ProcessEnv): string | undefined {
  return template.replace(/%([^%]+)%/g, (wholeMatch, name: string) => {
    const supplied = readEnv(env, name);
    if (supplied) {
      return supplied;
    }

    // These defaults preserve the documented system-wide locations even when
    // tests or constrained environments omit the corresponding env variable.
    if (name.toUpperCase() === "PROGRAMFILES") {
      return "C:\\Program Files";
    }
    if (name.toUpperCase() === "PROGRAMFILES(X86)") {
      return "C:\\Program Files (x86)";
    }

    // LocalAppData has no safe universal default; leave this candidate out.
    return wholeMatch;
  }).includes("%")
    ? undefined
    : template.replace(/%([^%]+)%/g, (_wholeMatch, name: string) => {
        const supplied = readEnv(env, name);
        if (supplied) {
          return supplied;
        }
        if (name.toUpperCase() === "PROGRAMFILES") {
          return "C:\\Program Files";
        }
        return "C:\\Program Files (x86)";
      });
}

function executableOnPath(
  executable: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  pathApi: typeof path,
): readonly string[] {
  const rawPath = readEnv(env, "PATH") ?? "";
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const extensions = platform === "win32" ? windowsExecutableExtensions(env, executable) : [""];

  return rawPath
    .split(delimiter)
    .map((directory) => directory.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => pathApi.join(directory, `${executable}${extension}`)));
}

function windowsExecutableExtensions(env: NodeJS.ProcessEnv, executable: string): readonly string[] {
  if (/\.(?:exe|cmd|bat)$/i.test(executable)) {
    return [""];
  }

  const pathExt = readEnv(env, "PATHEXT") ?? ".EXE;.CMD;.BAT;.COM";
  return pathExt
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
}

async function isExecutable(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) {
    return direct;
  }

  const normalized = name.toLowerCase();
  const matchingKey = Object.keys(env).find((key) => key.toLowerCase() === normalized);
  return matchingKey ? env[matchingKey] : undefined;
}

function normalizePath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
