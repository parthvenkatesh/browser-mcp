import type { BrowserName } from "../platform/browser-definitions.js";

export interface BrowserDiscoveryDiagnostics {
  requestedBrowser?: BrowserName;
  configuredExecutable?: string;
  checkedLocations: readonly string[];
  searchedBrowsers: readonly BrowserName[];
}

/** A user-actionable error emitted when a local browser cannot be used. */
export class BrowserNotFoundError extends Error {
  readonly code = "BROWSER_NOT_FOUND";
  readonly diagnostics: BrowserDiscoveryDiagnostics;

  constructor(diagnostics: BrowserDiscoveryDiagnostics, reason?: string) {
    const requested = diagnostics.requestedBrowser
      ? `Requested browser: ${diagnostics.requestedBrowser}.`
      : `Browsers searched: ${diagnostics.searchedBrowsers.join(", ")}.`;
    const configured = diagnostics.configuredExecutable
      ? ` Configured executable: ${diagnostics.configuredExecutable}.`
      : "";
    const checked = diagnostics.checkedLocations.length
      ? ` Checked: ${diagnostics.checkedLocations.join("; ")}.`
      : "";
    const guidance =
      " Install the requested browser, choose an installed browser, or set BROWSER_EXECUTABLE to its executable path.";

    super(`${reason ? `${reason} ` : ""}${requested}${configured}${checked}${guidance}`);
    this.name = "BrowserNotFoundError";
    this.diagnostics = diagnostics;
  }
}

export class BrowserConnectionError extends Error {
  readonly code = "BROWSER_CONNECTION_FAILED";

  constructor(endpoint: string, cause?: unknown) {
    const detail = cause instanceof Error ? ` ${cause.message}` : "";
    super(`Could not connect to the browser CDP endpoint ${endpoint}.${detail}`);
    this.name = "BrowserConnectionError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class BrowserNotStartedError extends Error {
  readonly code = "BROWSER_NOT_STARTED";

  constructor() {
    super("No browser is active. Call browser_start before using this tool.");
    this.name = "BrowserNotStartedError";
  }
}

export class BrowserMismatchError extends Error {
  readonly code = "BROWSER_MISMATCH";

  constructor(expected: BrowserName, actualProduct: string) {
    super(
      `The requested browser is ${expected}, but the connected CDP endpoint identifies as ${actualProduct}. ` +
        "Use a matching BROWSER/BROWSER_CDP_ENDPOINT pair.",
    );
    this.name = "BrowserMismatchError";
  }
}

export class UnknownTabError extends Error {
  readonly code = "UNKNOWN_TAB";

  constructor(tabId: string) {
    super(`No open tab has id "${tabId}".`);
    this.name = "UnknownTabError";
  }
}
