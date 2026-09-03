import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  loadConfig,
} from "../src/config/index.js";

describe("loadConfig", () => {
  it("uses safe launch defaults", () => {
    expect(loadConfig({})).toEqual({
      browser: undefined,
      executablePath: undefined,
      cdpEndpoint: undefined,
      connectionMode: "launch",
      headless: false,
      userDataDir: undefined,
      downloadDir: undefined,
      startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      logLevel: "info",
    });
  });

  it("preserves an explicitly requested browser for strict discovery", () => {
    const config = loadConfig({
      BROWSER: "EDGE",
      BROWSER_EXECUTABLE: " /custom/msedge ",
      BROWSER_HEADLESS: "true",
    });

    expect(config.browser).toBe("edge");
    expect(config.executablePath).toBe("/custom/msedge");
    expect(config.headless).toBe(true);
  });

  it("makes a supplied CDP endpoint take launch precedence", () => {
    const config = loadConfig({
      BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
      BROWSER: "chrome",
      BROWSER_EXECUTABLE: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });

    expect(config.connectionMode).toBe("existing-cdp");
    expect(config.cdpEndpoint).toBe("http://127.0.0.1:9222/");
    expect(config.browser).toBe("chrome");
  });

  it("rejects invalid values with the originating variable", () => {
    expect(() => loadConfig({ BROWSER: "firefox" })).toThrow(ConfigError);
    expect(() => loadConfig({ BROWSER_HEADLESS: "1" })).toThrow(
      'BROWSER_HEADLESS: must be "true" or "false".',
    );
    expect(() => loadConfig({ BROWSER_STARTUP_TIMEOUT: "0" })).toThrow(
      "BROWSER_STARTUP_TIMEOUT",
    );
    expect(() => loadConfig({ BROWSER_CDP_ENDPOINT: "ws://localhost:9222" })).toThrow(
      "BROWSER_CDP_ENDPOINT",
    );
  });
});
