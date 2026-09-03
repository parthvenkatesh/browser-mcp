import { rm } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";

import type { Browser, Page, ScreenshotOptions } from "puppeteer-core";

import type { Logger } from "../utils/logging.js";
import { findFreeLocalPort } from "../utils/ports.js";
import {
  discoverBrowser,
} from "../platform/browser-discovery.js";
import {
  inferBrowserNameFromProduct,
  parseBrowserName,
  type BrowserName,
} from "../platform/browser-definitions.js";
import {
  connectToBrowser,
  getCdpVersion,
  isWebSocketCdpEndpoint,
  normalizeCdpEndpoint,
  waitForCdpEndpoint,
} from "./cdp.js";
import {
  BrowserMismatchError,
  BrowserNotStartedError,
} from "./errors.js";
import {
  createBrowserProfile,
  launchBrowser,
  terminateBrowserProcess,
  type BrowserProfile,
  type LaunchedBrowser,
} from "./launcher.js";
import {
  PageManager,
  type BrowserTab,
  type PageNavigationResult,
} from "./page-manager.js";

/**
 * This intentionally mirrors BrowserConfig while remaining standalone so the
 * browser layer is usable outside the MCP server (for example in integration
 * tests or another transport).
 */
export interface BrowserManagerOptions {
  readonly browser?: BrowserName | string;
  readonly executablePath?: string;
  readonly cdpEndpoint?: string;
  readonly headless?: boolean;
  readonly userDataDir?: string;
  readonly downloadDir?: string;
  readonly startupTimeoutMs?: number;
  readonly defaultTimeoutMs?: number;
  readonly extraBrowserArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export interface BrowserStartOptions {
  /** Strict selection for this call; it never falls back to another browser. */
  readonly browser?: BrowserName | string;
  readonly executablePath?: string;
  readonly cdpEndpoint?: string;
  readonly headless?: boolean;
}

export interface BrowserCloseOptions {
  /** Also close an externally managed browser. Defaults to false. */
  readonly forceExternal?: boolean;
}

export interface BrowserSession {
  readonly browser: Browser;
  /** Alias maintained for callers that expect the current Puppeteer Page. */
  page: Page;
  activePage: Page;
  readonly pageManager: PageManager;
  readonly browserName: BrowserName;
  readonly product: string;
  readonly version: string;
  readonly cdpEndpoint: string;
  readonly owned: boolean;
  /** Known only for browsers launched by this manager. */
  readonly headless?: boolean;
  readonly process?: ChildProcess;
  readonly profile?: BrowserProfile;
  readonly executablePath?: string;
}

export interface BrowserStatus {
  readonly state: "not-started" | "connected" | "disconnected";
  readonly browser?: BrowserName;
  readonly product?: string;
  readonly version?: string;
  readonly cdpEndpoint?: string;
  readonly cdpConnected: boolean;
  readonly owned: boolean;
  readonly headless?: boolean;
  readonly tabCount: number;
  readonly activeTab?: BrowserTab;
  readonly currentUrl?: string;
  readonly currentTitle?: string;
}

export type BrowserScreenshotOptions = ScreenshotOptions;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 10_000;
const MAX_EVALUATE_SOURCE_LENGTH = 32_000;

/**
 * Owns one browser session at a time. It only kills a browser process and
 * removes a profile when this manager launched that process/profile itself.
 */
export class BrowserManager {
  private session?: BrowserSession;
  private startPromise?: Promise<BrowserSession>;
  private closing = false;

  constructor(
    private readonly options: BrowserManagerOptions = {},
    private readonly logger?: Logger,
  ) {}

  async start(options: BrowserStartOptions = {}): Promise<BrowserSession> {
    if (this.session?.browser.connected) {
      // Starting is intentionally idempotent, but an explicit selection is
      // still a contract. Never report a running Chrome session as Edge just
      // because a later caller asked for Edge.
      this.assertRequestedBrowser(this.resolveRequestedBrowser(options), this.session.product);
      await this.syncActivePage(this.session);
      return this.session;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    // A crashed/disconnected server-owned session can still hold a process or
    // temporary profile. Clean it up before replacing the session reference.
    if (this.session) {
      await this.close();
    }

    this.startPromise = this.startInternal(options).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async status(): Promise<BrowserStatus> {
    const session = this.session;
    if (!session) {
      return {
        state: "not-started",
        cdpConnected: false,
        owned: false,
        tabCount: 0,
      };
    }

    if (!session.browser.connected) {
      return this.disconnectedStatus(session);
    }

    try {
      const tabs = await session.pageManager.listTabs();
      const activeTab = tabs.find((tab) => tab.active);
      return {
        state: "connected",
        browser: session.browserName,
        product: session.product,
        version: session.version,
        cdpEndpoint: session.cdpEndpoint,
        cdpConnected: true,
        owned: session.owned,
        headless: session.headless,
        tabCount: tabs.length,
        ...(activeTab ? { activeTab, currentUrl: activeTab.url, currentTitle: activeTab.title } : {}),
      };
    } catch (error) {
      // A CDP disconnect can race with a status probe. Status is diagnostic,
      // so return the useful disconnected state instead of surfacing a stale
      // Puppeteer transport error.
      if (!session.browser.connected) {
        return this.disconnectedStatus(session);
      }
      throw error;
    }
  }

  async close(options: BrowserCloseOptions = {}): Promise<BrowserStatus> {
    const session = this.session;
    if (!session) {
      return this.status();
    }

    this.closing = true;
    // Make the manager unavailable immediately; this prevents another tool
    // call from accidentally acting on a browser while it is being torn down.
    this.session = undefined;
    try {
      if (session.owned || options.forceExternal) {
        try {
          await session.browser.close();
        } catch (error) {
          this.logger?.warn("Browser close command failed; proceeding with owned-process cleanup.", {
            error,
            owned: session.owned,
          });
        }
      } else {
        // Disconnect only. Do not send Browser.close to a browser the user or
        // another application owns.
        session.browser.disconnect();
      }

      if (session.owned && session.process) {
        await terminateBrowserProcess(session.process);
      }
    } finally {
      if (session.profile?.owned) {
        await removeOwnedProfile(session.profile.profileDir, this.logger);
      }
      this.closing = false;
    }

    this.logger?.info("Browser session closed.", { owned: session.owned });
    return this.status();
  }

  async requireActivePage(): Promise<Page> {
    const session = this.requireSession();
    const page = await session.pageManager.ensureActivePage();
    session.page = page;
    session.activePage = page;
    return page;
  }

  getSession(): BrowserSession | undefined {
    return this.session;
  }

  async listTabs(): Promise<BrowserTab[]> {
    const session = this.requireSession();
    const tabs = await session.pageManager.listTabs();
    await this.syncActivePage(session);
    return tabs;
  }

  async newTab(url?: string): Promise<BrowserTab> {
    const session = this.requireSession();
    const tab = await session.pageManager.newTab(url);
    await this.syncActivePage(session);
    return tab;
  }

  async switchTab(tabId: string): Promise<BrowserTab> {
    const session = this.requireSession();
    const tab = await session.pageManager.switchTab(tabId);
    await this.syncActivePage(session);
    return tab;
  }

  async closeTab(tabId: string): Promise<void> {
    const session = this.requireSession();
    await session.pageManager.closeTab(tabId);
    await this.syncActivePage(session);
  }

  async navigate(url: string): Promise<PageNavigationResult> {
    const session = this.requireSession();
    const result = await session.pageManager.navigate(url);
    await this.syncActivePage(session);
    return result;
  }

  async goBack(): Promise<PageNavigationResult> {
    const session = this.requireSession();
    const result = await session.pageManager.goBack();
    await this.syncActivePage(session);
    return result;
  }

  async goForward(): Promise<PageNavigationResult> {
    const session = this.requireSession();
    const result = await session.pageManager.goForward();
    await this.syncActivePage(session);
    return result;
  }

  async reload(): Promise<PageNavigationResult> {
    const session = this.requireSession();
    const result = await session.pageManager.reload();
    await this.syncActivePage(session);
    return result;
  }

  async screenshot(fullPage?: boolean): Promise<Buffer>;
  async screenshot(options?: BrowserScreenshotOptions): Promise<Buffer>;
  async screenshot(fullPageOrOptions: boolean | BrowserScreenshotOptions = {}): Promise<Buffer> {
    const page = await this.requireActivePage();
    const options = typeof fullPageOrOptions === "boolean"
      ? { fullPage: fullPageOrOptions }
      : fullPageOrOptions;
    return Buffer.from(await page.screenshot(options));
  }

  /**
   * Evaluate a JavaScript expression in the active page only. This is kept
   * deliberately bounded; MCP tool wiring can impose additional policy.
   */
  async evaluate(expression: string): Promise<unknown> {
    if (expression.length > MAX_EVALUATE_SOURCE_LENGTH) {
      throw new Error(`Evaluation source exceeds the ${MAX_EVALUATE_SOURCE_LENGTH}-character limit.`);
    }
    const page = await this.requireActivePage();
    return page.evaluate(expression);
  }

  private async startInternal(startOptions: BrowserStartOptions): Promise<BrowserSession> {
    const requestedBrowser = this.resolveRequestedBrowser(startOptions);
    const cdpEndpoint = startOptions.cdpEndpoint ?? this.options.cdpEndpoint ?? this.options.env?.BROWSER_CDP_ENDPOINT;

    if (cdpEndpoint) {
      return this.connectExistingBrowser(cdpEndpoint, requestedBrowser);
    }

    return this.launchOwnedBrowser(startOptions, requestedBrowser);
  }

  private async connectExistingBrowser(
    endpoint: string,
    requestedBrowser: BrowserName | undefined,
  ): Promise<BrowserSession> {
    const normalizedEndpoint = normalizeCdpEndpoint(endpoint);
    const versionInfo = isWebSocketCdpEndpoint(normalizedEndpoint)
      ? undefined
      : await getCdpVersion(normalizedEndpoint, this.resolveStartupTimeout());
    const browser = await connectToBrowser(normalizedEndpoint);

    try {
      const product = versionInfo?.browser ?? (await browser.version());
      this.assertRequestedBrowser(requestedBrowser, product);
      const browserName = inferBrowserNameFromProduct(product) ?? requestedBrowser ?? "chrome";
      const manager = new PageManager(browser, {
        navigationTimeoutMs: this.resolveNavigationTimeout(),
      });
      const page = await manager.ensureActivePage();
      const session: BrowserSession = {
        browser,
        page,
        activePage: page,
        pageManager: manager,
        browserName,
        product,
        version: product,
        cdpEndpoint: normalizedEndpoint,
        owned: false,
      };
      this.installDisconnectHandler(session);
      this.session = session;
      this.logger?.info("Connected to externally managed browser.", {
        browser: browserName,
        endpoint: normalizedEndpoint,
      });
      return session;
    } catch (error) {
      browser.disconnect();
      throw error;
    }
  }

  private async launchOwnedBrowser(
    startOptions: BrowserStartOptions,
    requestedBrowser: BrowserName | undefined,
  ): Promise<BrowserSession> {
    const executableOverride = startOptions.executablePath ?? this.options.executablePath;
    const discovered = await discoverBrowser({
      browser: requestedBrowser,
      executablePath: executableOverride,
      env: this.options.env,
      platform: this.options.platform,
    });
    const profile = await createBrowserProfile(this.options.userDataDir, this.options.downloadDir);
    let launched: LaunchedBrowser | undefined;
    let browser: Browser | undefined;
    const headless = startOptions.headless ?? this.options.headless ?? false;

    try {
      const port = await findFreeLocalPort();
      launched = launchBrowser({
        executablePath: discovered.executablePath,
        cdpPort: port,
        profile,
        headless,
        extraArgs: this.options.extraBrowserArgs,
        env: this.options.env,
      });
      const versionInfo = await waitForCdpEndpoint(launched.cdpEndpoint, {
        timeoutMs: this.resolveStartupTimeout(),
        isProcessRunning: () => launched?.process.exitCode === null && launched.process.signalCode === null,
      });
      browser = await connectToBrowser(launched.cdpEndpoint);
      this.assertRequestedBrowser(requestedBrowser, versionInfo.browser);

      const browserName = inferBrowserNameFromProduct(versionInfo.browser) ?? discovered.browser;
      const manager = new PageManager(browser, {
        navigationTimeoutMs: this.resolveNavigationTimeout(),
      });
      const page = await manager.ensureActivePage();
      await configureOwnedDownloads(browser, profile.downloadDir, this.logger);

      const session: BrowserSession = {
        browser,
        page,
        activePage: page,
        pageManager: manager,
        browserName,
        product: versionInfo.browser,
        version: versionInfo.browser,
        cdpEndpoint: launched.cdpEndpoint,
        owned: true,
        headless,
        process: launched.process,
        profile,
        executablePath: discovered.executablePath,
      };
      this.installDisconnectHandler(session);
      this.session = session;
      this.logger?.info("Started local browser.", {
        browser: browserName,
        executablePath: discovered.executablePath,
        cdpEndpoint: launched.cdpEndpoint,
        profileDir: profile.profileDir,
      });
      return session;
    } catch (error) {
      browser?.disconnect();
      if (launched) {
        await terminateBrowserProcess(launched.process);
      }
      if (profile.owned) {
        await removeOwnedProfile(profile.profileDir, this.logger);
      }
      throw error;
    }
  }

  private requireSession(): BrowserSession {
    if (!this.session || !this.session.browser.connected) {
      throw new BrowserNotStartedError();
    }
    return this.session;
  }

  private async syncActivePage(session: BrowserSession): Promise<void> {
    const page = await session.pageManager.ensureActivePage();
    session.page = page;
    session.activePage = page;
  }

  private resolveStartupTimeout(): number {
    return this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  private resolveNavigationTimeout(): number {
    return this.options.defaultTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  }

  private resolveRequestedBrowser(startOptions: BrowserStartOptions): BrowserName | undefined {
    return parseBrowserName(startOptions.browser ?? this.options.browser ?? this.options.env?.BROWSER);
  }

  private disconnectedStatus(session: BrowserSession): BrowserStatus {
    return {
      state: "disconnected",
      browser: session.browserName,
      product: session.product,
      version: session.version,
      cdpEndpoint: session.cdpEndpoint,
      cdpConnected: false,
      owned: session.owned,
      headless: session.headless,
      tabCount: 0,
    };
  }

  private assertRequestedBrowser(requestedBrowser: BrowserName | undefined, product: string): void {
    if (!requestedBrowser) {
      return;
    }
    const detectedBrowser = inferBrowserNameFromProduct(product);
    if (detectedBrowser !== requestedBrowser) {
      throw new BrowserMismatchError(requestedBrowser, product);
    }
  }

  private installDisconnectHandler(session: BrowserSession): void {
    session.browser.once("disconnected", () => {
      if (this.session === session && !this.closing) {
        this.logger?.warn("Browser CDP connection disconnected.", {
          browser: session.browserName,
          owned: session.owned,
        });
      }
    });
  }
}

async function configureOwnedDownloads(browser: Browser, downloadPath: string, logger?: Logger): Promise<void> {
  try {
    const client = await browser.target().createCDPSession();
    try {
      await client.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath,
        eventsEnabled: true,
      });
    } finally {
      await client.detach();
    }
  } catch (error) {
    // Download behavior is a Chromium-version capability. A browser that does
    // not implement it remains usable, with Chromium's normal download policy.
    logger?.warn("Could not configure browser download behavior.", { error });
  }
}

async function removeOwnedProfile(profileDir: string, logger?: Logger): Promise<void> {
  try {
    await rm(profileDir, { recursive: true, force: true, maxRetries: 2 });
  } catch (error) {
    logger?.warn("Could not remove temporary browser profile.", { profileDir, error });
  }
}
