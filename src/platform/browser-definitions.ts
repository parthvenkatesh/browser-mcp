/**
 * Definitions for Chromium-family browsers supported by the server.
 *
 * Keep this module data-only where possible: discovery and launching use these
 * definitions, and adding another Chromium-based browser is generally just a
 * matter of adding an entry here.
 */

export const BROWSER_NAMES = ["chrome", "chromium", "edge"] as const;

export type BrowserName = (typeof BROWSER_NAMES)[number];

export interface BrowserDefinition {
  readonly id: BrowserName;
  readonly displayName: string;
  /** Executable basenames to look up in PATH, in preference order. */
  readonly pathExecutables: readonly string[];
  /** macOS app bundle executable paths, relative to a user's home when marked with ~. */
  readonly macosPaths: readonly string[];
  /** Windows executable paths. Environment variables are expanded by discovery. */
  readonly windowsPaths: readonly string[];
  /** Tokens normally present in the CDP product/version response. */
  readonly productTokens: readonly string[];
}

export const BROWSER_DEFINITIONS: Readonly<Record<BrowserName, BrowserDefinition>> = {
  chrome: {
    id: "chrome",
    displayName: "Google Chrome",
    pathExecutables: ["google-chrome", "google-chrome-stable", "chrome", "Google Chrome"],
    macosPaths: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ],
    windowsPaths: [
      "%PROGRAMFILES%\\Google\\Chrome\\Application\\chrome.exe",
      "%PROGRAMFILES(X86)%\\Google\\Chrome\\Application\\chrome.exe",
      "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
    ],
    productTokens: ["chrome"],
  },
  chromium: {
    id: "chromium",
    displayName: "Chromium",
    pathExecutables: ["chromium", "chromium-browser", "chrome"],
    macosPaths: [
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "~/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    windowsPaths: [
      "%PROGRAMFILES%\\Chromium\\Application\\chrome.exe",
      "%PROGRAMFILES(X86)%\\Chromium\\Application\\chrome.exe",
      "%LOCALAPPDATA%\\Chromium\\Application\\chrome.exe",
    ],
    productTokens: ["chromium"],
  },
  edge: {
    id: "edge",
    displayName: "Microsoft Edge",
    pathExecutables: ["msedge", "microsoft-edge", "Microsoft Edge"],
    macosPaths: [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "~/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    windowsPaths: [
      "%PROGRAMFILES%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%PROGRAMFILES(X86)%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    productTokens: ["edge", "edg/"],
  },
} as const;

export function isBrowserName(value: string): value is BrowserName {
  return (BROWSER_NAMES as readonly string[]).includes(value);
}

/**
 * Normalizes a user-facing browser value. Environment variables are commonly
 * typed in mixed case, so accepting that is friendlier while preserving a
 * small, explicit supported set.
 */
export function parseBrowserName(value: string | undefined): BrowserName | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!isBrowserName(normalized)) {
    throw new UnsupportedBrowserError(value);
  }

  return normalized;
}

export function inferBrowserNameFromPath(executablePath: string): BrowserName | undefined {
  const normalized = executablePath.toLowerCase();
  if (normalized.includes("edge") || normalized.includes("msedge")) {
    return "edge";
  }
  if (normalized.includes("chromium")) {
    return "chromium";
  }
  if (normalized.includes("chrome")) {
    return "chrome";
  }
  return undefined;
}

/** The best-effort classification used after connecting over CDP. */
export function inferBrowserNameFromProduct(product: string | undefined): BrowserName | undefined {
  if (!product) {
    return undefined;
  }

  const normalized = product.toLowerCase();
  if (normalized.includes("edge") || normalized.includes("edg/")) {
    return "edge";
  }
  if (normalized.includes("chromium")) {
    return "chromium";
  }
  if (normalized.includes("chrome")) {
    return "chrome";
  }
  return undefined;
}

export class UnsupportedBrowserError extends Error {
  readonly code = "UNSUPPORTED_BROWSER";

  constructor(value: string) {
    super(
      `Unsupported browser "${value}". Supported browsers: ${BROWSER_NAMES.join(", ")}.`,
    );
    this.name = "UnsupportedBrowserError";
  }
}
