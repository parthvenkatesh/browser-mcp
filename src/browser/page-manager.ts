import type { Browser, Page } from "puppeteer-core";

import { UnknownTabError } from "./errors.js";

export interface BrowserTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

export interface PageNavigationResult {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly status?: number;
}

export interface PageManagerOptions {
  readonly navigationTimeoutMs?: number;
}

/**
 * A small tab abstraction over Puppeteer pages. IDs are server-generated
 * rather than leaking CDP target IDs to MCP clients.
 */
export class PageManager {
  private readonly idsByPage = new WeakMap<Page, string>();
  private readonly pagesById = new Map<string, Page>();
  private activeTabId?: string;
  private nextTabNumber = 1;
  private readonly navigationTimeoutMs: number;

  constructor(
    private readonly browser: Browser,
    options: PageManagerOptions = {},
  ) {
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
  }

  async ensureActivePage(): Promise<Page> {
    await this.refresh();
    const active = this.activeTabId ? this.pagesById.get(this.activeTabId) : undefined;
    if (active && !active.isClosed()) {
      return active;
    }

    const first = this.pagesById.values().next().value as Page | undefined;
    if (first && !first.isClosed()) {
      this.activeTabId = this.getId(first);
      return first;
    }

    const page = await this.browser.newPage();
    this.register(page);
    this.activeTabId = this.getId(page);
    return page;
  }

  async activePage(): Promise<Page | undefined> {
    await this.refresh();
    const page = this.activeTabId ? this.pagesById.get(this.activeTabId) : undefined;
    if (page && !page.isClosed()) {
      return page;
    }

    const first = this.pagesById.values().next().value as Page | undefined;
    if (first && !first.isClosed()) {
      this.activeTabId = this.getId(first);
      return first;
    }
    return undefined;
  }

  async listTabs(): Promise<BrowserTab[]> {
    await this.refresh();
    const tabs = [...this.pagesById.entries()];
    return Promise.all(
      tabs.map(async ([id, page]) => ({
        id,
        url: page.url(),
        title: await safeTitle(page),
        active: id === this.activeTabId,
      })),
    );
  }

  async newTab(url?: string): Promise<BrowserTab> {
    const page = await this.browser.newPage();
    const id = this.register(page);
    this.activeTabId = id;
    await page.bringToFront();
    if (url) {
      await page.goto(url, this.navigationOptions());
    }
    return this.toTab(id, page);
  }

  async switchTab(tabId: string): Promise<BrowserTab> {
    const page = await this.getPage(tabId);
    await page.bringToFront();
    this.activeTabId = tabId;
    return this.toTab(tabId, page);
  }

  async closeTab(tabId: string): Promise<void> {
    const page = await this.getPage(tabId);
    await page.close({ runBeforeUnload: false });
    this.pagesById.delete(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = undefined;
      await this.activePage();
    }
  }

  async navigate(url: string): Promise<PageNavigationResult> {
    const page = await this.ensureActivePage();
    const response = await page.goto(url, this.navigationOptions());
    return this.navigationResult(page, response?.status());
  }

  async goBack(): Promise<PageNavigationResult> {
    const page = await this.ensureActivePage();
    const response = await page.goBack(this.navigationOptions());
    return this.navigationResult(page, response?.status());
  }

  async goForward(): Promise<PageNavigationResult> {
    const page = await this.ensureActivePage();
    const response = await page.goForward(this.navigationOptions());
    return this.navigationResult(page, response?.status());
  }

  async reload(): Promise<PageNavigationResult> {
    const page = await this.ensureActivePage();
    const response = await page.reload(this.navigationOptions());
    return this.navigationResult(page, response?.status());
  }

  private async navigationResult(page: Page, status?: number): Promise<PageNavigationResult> {
    return {
      tabId: this.getId(page),
      url: page.url(),
      title: await safeTitle(page),
      status,
    };
  }

  private async toTab(id: string, page: Page): Promise<BrowserTab> {
    return {
      id,
      url: page.url(),
      title: await safeTitle(page),
      active: id === this.activeTabId,
    };
  }

  private navigationOptions(): { waitUntil: "domcontentloaded"; timeout: number } {
    return { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs };
  }

  private async getPage(tabId: string): Promise<Page> {
    await this.refresh();
    const page = this.pagesById.get(tabId);
    if (!page || page.isClosed()) {
      this.pagesById.delete(tabId);
      throw new UnknownTabError(tabId);
    }
    return page;
  }

  private async refresh(): Promise<void> {
    const currentPages = await this.browser.pages();
    const currentPageSet = new Set(currentPages.filter((page) => !page.isClosed()));

    for (const [id, page] of this.pagesById) {
      if (!currentPageSet.has(page)) {
        this.pagesById.delete(id);
        if (this.activeTabId === id) {
          this.activeTabId = undefined;
        }
      }
    }

    for (const page of currentPageSet) {
      this.register(page);
    }

    if (!this.activeTabId) {
      const first = currentPageSet.values().next().value as Page | undefined;
      if (first) {
        this.activeTabId = this.getId(first);
      }
    }
  }

  private register(page: Page): string {
    const known = this.idsByPage.get(page);
    if (known) {
      this.pagesById.set(known, page);
      return known;
    }

    const id = `tab-${this.nextTabNumber++}`;
    this.idsByPage.set(page, id);
    this.pagesById.set(id, page);
    return id;
  }

  private getId(page: Page): string {
    return this.register(page);
  }
}

async function safeTitle(page: Page): Promise<string> {
  try {
    return await page.title();
  } catch {
    return "";
  }
}
