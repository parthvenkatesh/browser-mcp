import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Page } from "puppeteer-core";

import type { BrowserConfig } from "../config/index.js";
import { BrowserManager } from "../browser/browser-manager.js";
import { ElementRegistry } from "../exploration/ElementRegistry.js";
import { Observer } from "../exploration/Observer.js";
import {
  toSerializableObservation,
  type Interactable,
  type Observation,
} from "../exploration/SemanticModel.js";
import { InteractionService } from "../interaction/InteractionService.js";
import { WaitService } from "../interaction/WaitService.js";
import type { Logger } from "../utils/logging.js";
import { BrowserMcpError } from "./errors.js";
import { renderObservation } from "./format.js";
import { failure, success } from "./result.js";
import {
  closeInputSchema,
  closeTabInputSchema,
  evaluateInputSchema,
  fillInputSchema,
  navigateInputSchema,
  newTabInputSchema,
  pressInputSchema,
  refInputSchema,
  screenshotInputSchema,
  selectInputSchema,
  startInputSchema,
  switchFrameInputSchema,
  switchTabInputSchema,
  typeInputSchema,
  waitForElementInputSchema,
  waitInputSchema,
} from "./schemas.js";

export const SERVER_NAME = "browser-exploration-mcp";
export const SERVER_VERSION = "0.1.0";

export interface BrowserMcpServerOptions {
  config: BrowserConfig;
  logger: Logger;
  /** Useful for integration tests; production code normally omits this. */
  browserManager?: BrowserManager;
}

/**
 * Creates the semantic MCP interface. All browser/CDP details live behind
 * BrowserManager, Observer, and InteractionService; callers only receive
 * opaque element refs and semantic state.
 */
export function createBrowserMcpServer(options: BrowserMcpServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const registry = new ElementRegistry();
  const browser = options.browserManager ?? new BrowserManager(
    {
      ...options.config,
      onFrameContextChanged: (reason) => registry.invalidate(reason),
    },
    options.logger,
  );
  const observer = new Observer({ registry });
  const interactions = new InteractionService(browser, observer, registry, {
    postActionTimeoutMs: Math.min(options.config.defaultTimeoutMs, 1_500),
  });
  const waits = new WaitService(registry);
  const defaultTimeout = options.config.defaultTimeoutMs;

  server.registerTool(
    "browser_start",
    {
      title: "Start browser",
      description:
        "Validate and start the requested locally installed Chrome, Chromium, or Edge browser, or connect to the configured CDP endpoint.",
      inputSchema: startInputSchema,
    },
    guard(options.logger, "browser_start", async ({ browser: requestedBrowser }) => {
      const session = await browser.start({ browser: requestedBrowser });
      registry.invalidate("A browser session was started or selected.");
      const status = await browser.status();
      return success(
        {
          ...status,
          browser: session.browserName,
          version: session.version,
          cdpConnected: true,
          headless: options.config.headless,
        },
        `Browser ready: ${session.browserName} (${session.version}).`,
      );
    }),
  );

  server.registerTool(
    "browser_status",
    {
      title: "Browser status",
      description: "Return the current browser connection, active tab, URL, and title.",
    },
    guard(options.logger, "browser_status", async () => success(await browser.status())),
  );

  server.registerTool(
    "browser_close",
    {
      title: "Close browser session",
      description:
        "Close a browser launched by this server and clean its temporary resources. External CDP browsers are only disconnected by default.",
      inputSchema: closeInputSchema,
    },
    guard(options.logger, "browser_close", async ({ forceExternal }) => {
      registry.invalidate("The browser session was closed.");
      return success(await browser.close({ forceExternal }));
    }),
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate",
      description: "Navigate the active tab to an absolute URL and wait for DOM content to load.",
      inputSchema: navigateInputSchema,
    },
    guard(options.logger, "browser_navigate", async ({ url }) => {
      const navigation = await browser.navigate(url);
      registry.invalidate("Navigation replaced the current page state.");
      const observation = await observeCurrent(browser, observer);
      return observationResult({ navigation }, observation, `Navigated to ${navigation.url}.`);
    }),
  );

  registerNavigationTool(server, options.logger, "browser_back", "Navigate back in the active tab.", async () => {
    const navigation = await browser.goBack();
    registry.invalidate("History navigation replaced the current page state.");
    return observationResult({ navigation }, await observeCurrent(browser, observer), "Navigated back.");
  });
  registerNavigationTool(server, options.logger, "browser_forward", "Navigate forward in the active tab.", async () => {
    const navigation = await browser.goForward();
    registry.invalidate("History navigation replaced the current page state.");
    return observationResult({ navigation }, await observeCurrent(browser, observer), "Navigated forward.");
  });
  registerNavigationTool(server, options.logger, "browser_reload", "Reload the active tab.", async () => {
    const navigation = await browser.reload();
    registry.invalidate("Reload replaced the current page state.");
    return observationResult({ navigation }, await observeCurrent(browser, observer), "Reloaded the active tab.");
  });

  server.registerTool(
    "browser_observe",
    {
      title: "Observe page",
      description:
        "Inspect the active page and return visible semantic elements, forms, tables, dialogs, menus, notifications, and fresh opaque element references.",
    },
    guard(options.logger, "browser_observe", async () => {
      const observation = await observeCurrent(browser, observer);
      return observationResult({}, observation);
    }),
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click element",
      description: "Click a visible and enabled element returned by browser_observe.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "browser_click", async (target) => actionResult(await interactions.click(target))),
  );

  server.registerTool(
    "browser_fill",
    {
      title: "Fill input",
      description: "Replace an input value while dispatching framework-compatible input and change events.",
      inputSchema: fillInputSchema,
    },
    guard(options.logger, "browser_fill", async ({ value, ...target }) => actionResult(await interactions.fill(target, value))),
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type text",
      description: "Focus an observed text-capable element and type text using browser keyboard events.",
      inputSchema: typeInputSchema,
    },
    guard(options.logger, "browser_type", async ({ text, ...target }) => actionResult(await interactions.type(target, text))),
  );

  server.registerTool(
    "browser_press",
    {
      title: "Press key",
      description: "Focus an observed element and press a supported keyboard key.",
      inputSchema: pressInputSchema,
    },
    guard(options.logger, "browser_press", async ({ key, ...target }) => actionResult(await interactions.press(target, key))),
  );

  server.registerTool(
    "browser_select",
    {
      title: "Select option",
      description: "Select a native option by value or visible text, or use accessible keyboard selection for a custom combobox.",
      inputSchema: selectInputSchema,
    },
    guard(options.logger, "browser_select", async ({ value, ...target }) => actionResult(await interactions.select(target, value))),
  );

  server.registerTool(
    "browser_check",
    {
      title: "Check control",
      description: "Check a checkbox, radio control, or switch if it is not already checked.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "browser_check", async (target) => actionResult(await interactions.setChecked(target, true))),
  );

  server.registerTool(
    "browser_uncheck",
    {
      title: "Uncheck control",
      description: "Uncheck a checkbox, radio control, or switch if it is currently checked.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "browser_uncheck", async (target) => actionResult(await interactions.setChecked(target, false))),
  );

  server.registerTool(
    "browser_hover",
    {
      title: "Hover element",
      description: "Hover over an observed element and return the resulting semantic state.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "browser_hover", async (target) => actionResult(await interactions.hover(target))),
  );

  server.registerTool(
    "browser_focus",
    {
      title: "Focus element",
      description: "Focus an observed element and return the resulting semantic state.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "browser_focus", async (target) => actionResult(await interactions.focus(target))),
  );

  server.registerTool(
    "browser_wait",
    {
      title: "Wait for browser condition",
      description: "Wait for a meaningful browser, element, or text condition without arbitrary sleeps.",
      inputSchema: waitInputSchema,
    },
    guard(options.logger, "browser_wait", async (request) => {
      const result = await waits.wait(await browser.requireActivePage(), await browser.requireActiveFrame(), {
        ...request,
        timeout: request.timeout ?? defaultTimeout,
      });
      const observation = await observeCurrent(browser, observer);
      return observationResult({ wait: result }, observation, `Wait condition ${result.condition} met.`);
    }),
  );

  server.registerTool(
    "browser_wait_for_element",
    {
      title: "Wait for semantic element",
      description: "Wait until an element matching a role and/or accessible name appears, then return a fresh observation.",
      inputSchema: waitForElementInputSchema,
    },
    guard(options.logger, "browser_wait_for_element", async ({ role, name, timeout }) => {
      const page = await browser.requireActiveFrame();
      await waitForSemanticElement(page, { role, name }, timeout ?? defaultTimeout);
      const observation = await observeCurrent(browser, observer);
      const element = observation.interactables.find((candidate) => matchesSemanticElement(candidate, { role, name }));
      if (!element) {
        throw new BrowserMcpError(
          "SEMANTIC_ELEMENT_NOT_FOUND",
          "The DOM condition was met but no safely observable matching element was found. Call browser_observe for the current state.",
        );
      }
      return observationResult({ element }, observation, `Found [${element.ref}] ${element.role}.`);
    }),
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Capture screenshot",
      description: "Capture a viewport or full-page PNG screenshot of the active tab.",
      inputSchema: screenshotInputSchema,
    },
    guard(options.logger, "browser_screenshot", async ({ fullPage }) => {
      const image = await browser.screenshot({ fullPage, type: "png" });
      return {
        content: [
          { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" as const },
          { type: "text" as const, text: `Captured ${fullPage ? "full-page" : "viewport"} screenshot.` },
        ],
        structuredContent: { fullPage, mimeType: "image/png" },
      };
    }),
  );

  server.registerTool(
    "browser_list_tabs",
    {
      title: "List tabs",
      description: "Return all open tabs with opaque tab IDs, URLs, titles, and active status.",
    },
    guard(options.logger, "browser_list_tabs", async () => success({ tabs: await browser.listTabs() })),
  );

  server.registerTool(
    "browser_new_tab",
    {
      title: "New tab",
      description: "Create and activate a new tab, optionally navigating it to a URL.",
      inputSchema: newTabInputSchema,
    },
    guard(options.logger, "browser_new_tab", async ({ url }) => {
      const tab = await browser.newTab(url);
      registry.invalidate("The active tab changed.");
      return success({ tab });
    }),
  );

  server.registerTool(
    "browser_switch_tab",
    {
      title: "Switch tab",
      description: "Activate an existing tab by its opaque tab ID.",
      inputSchema: switchTabInputSchema,
    },
    guard(options.logger, "browser_switch_tab", async ({ tabId }) => {
      const tab = await browser.switchTab(tabId);
      registry.invalidate("The active tab changed.");
      const observation = await observeCurrent(browser, observer);
      return observationResult({ tab }, observation, `Switched to ${tab.id}.`);
    }),
  );

  server.registerTool(
    "browser_close_tab",
    {
      title: "Close tab",
      description: "Close a tab by its opaque tab ID and select another available active tab.",
      inputSchema: closeTabInputSchema,
    },
    guard(options.logger, "browser_close_tab", async ({ tabId }) => {
      await browser.closeTab(tabId);
      registry.invalidate("A tab was closed.");
      return success(await browser.status());
    }),
  );

  server.registerTool(
    "browser_list_frames",
    {
      title: "List frames",
      description: "List the active tab's main frame and attached child frames with opaque frame IDs.",
    },
    guard(options.logger, "browser_list_frames", async () => success({ frames: await browser.listFrames() })),
  );

  server.registerTool(
    "browser_switch_frame",
    {
      title: "Switch frame",
      description: "Select an attached frame by ID. Call browser_list_frames to return to the main frame or choose another frame.",
      inputSchema: switchFrameInputSchema,
    },
    guard(options.logger, "browser_switch_frame", async ({ frameId }) => {
      registry.invalidate("The active frame changed.");
      return success({ frame: await browser.switchFrame(frameId) });
    }),
  );

  server.registerTool(
    "browser_evaluate",
    {
      title: "Evaluate page expression",
      description:
        "Evaluate a bounded JavaScript expression in the active web page only. It cannot access the Node.js process, filesystem, or shell.",
      inputSchema: evaluateInputSchema,
    },
    guard(options.logger, "browser_evaluate", async ({ expression }) => {
      try {
        const result = await browser.evaluate(expression);
        return success({ result: serializeEvaluationResult(result) });
      } catch (error) {
        throw new BrowserMcpError(
          "PAGE_EVALUATION_FAILED",
          `Unable to evaluate the page expression: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }),
  );

  return server;
}

function registerNavigationTool(
  server: McpServer,
  logger: Logger,
  name: string,
  description: string,
  handler: () => Promise<CallToolResult>,
): void {
  server.registerTool(name, { title: name.replace("browser_", "").replace(/_/g, " "), description }, guard(logger, name, handler));
}

function guard<Args>(
  logger: Logger,
  tool: string,
  handler: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      logger.warn("MCP browser tool failed.", {
        tool,
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      });
      return failure(error);
    }
  };
}

async function observeCurrent(browser: BrowserManager, observer: Observer): Promise<Observation> {
  return observer.observe(await browser.requireActiveFrame());
}

function observationResult(
  extra: Record<string, unknown>,
  observation: Observation,
  summary?: string,
) {
  const serializable = toSerializableObservation(observation);
  return success(
    { ...extra, observation: serializable },
    summary ? `${summary}\n\n${renderObservation(observation)}` : renderObservation(observation),
  );
}

function actionResult(result: Awaited<ReturnType<InteractionService["click"]>>) {
  return observationResult(
    { action: result.action, ref: result.ref, stateChanged: result.stateChanged },
    result.observation,
    `${capitalize(result.action)} succeeded for ref=${result.ref}.${result.stateChanged ? " Page state changed." : ""}`,
  );
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const value = (error as { code?: unknown }).code;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function serializeEvaluationResult(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

interface SemanticCriteria {
  role?: string;
  name?: string;
}

async function waitForSemanticElement(
  page: Pick<Page, "waitForFunction">,
  criteria: SemanticCriteria,
  timeout: number,
): Promise<void> {
  await page.waitForFunction(
    (requested) => {
      const normalized = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const nativeRole = (element: Element): string => {
        const html = element as HTMLElement;
        const tag = element.tagName.toLowerCase();
        if (tag === "button" || tag === "summary") return "button";
        if (tag === "a" && html.hasAttribute("href")) return "link";
        if (tag === "textarea" || html.isContentEditable) return "textbox";
        if (tag === "select") return "combobox";
        if (tag === "input") {
          const type = (html as HTMLInputElement).type.toLowerCase();
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "search") return "searchbox";
          return "textbox";
        }
        return "other";
      };
      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        const style = getComputedStyle(html);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      return Array.from(document.querySelectorAll("button,a[href],input,textarea,select,[role],[onclick],[tabindex]"))
        .some((element) => {
          if (!visible(element)) return false;
          const html = element as HTMLElement;
          const role = normalized(html.getAttribute("role") || nativeRole(element));
          const name = normalized(
            html.getAttribute("aria-label") || html.getAttribute("placeholder") || html.innerText || html.textContent,
          );
          return (!requested.role || role === normalized(requested.role)) &&
            (!requested.name || name.includes(normalized(requested.name)));
        });
    },
    { timeout },
    criteria,
  );
}

function matchesSemanticElement(element: Interactable, criteria: SemanticCriteria): boolean {
  if (criteria.role && element.role !== criteria.role) {
    return false;
  }
  if (!criteria.name) {
    return true;
  }
  const label = element.name ?? element.text ?? element.placeholder ?? "";
  return label.toLowerCase().includes(criteria.name.toLowerCase());
}
