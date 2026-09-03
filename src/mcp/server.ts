import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Frame, Page } from "puppeteer-core";

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
  clickInputSchema,
  assertInputSchema,
  constructLocatorInputSchema,
  clearInputSchema,
  evaluateInputSchema,
  fillInputSchema,
  navigateInputSchema,
  newTabInputSchema,
  pressInputSchema,
  refInputSchema,
  screenshotInputSchema,
  selectInputSchema,
  observeOptionsSchema,
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
    guard(options.logger, "browser_start", async ({ browser: requestedBrowser, useUserProfile }) => {
      const session = await browser.start({ browser: requestedBrowser, useUserProfile });
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
      inputSchema: observeOptionsSchema,
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

  registerNavigationTool(server, options.logger, "browser_back", "Navigate back in the active tab.", async ({ lean, observeMode }) => {
    const navigation = await browser.goBack();
    registry.invalidate("History navigation replaced the current page state.");
    return observationResult({ navigation }, await observeCurrent(browser, observer), "Navigated back.", lean, observeMode);
  });
  registerNavigationTool(server, options.logger, "browser_forward", "Navigate forward in the active tab.", async ({ lean, observeMode }) => {
    const navigation = await browser.goForward();
    registry.invalidate("History navigation replaced the current page state.");
    return observationResult({ navigation }, await observeCurrent(browser, observer), "Navigated forward.", lean, observeMode);
  });
  registerNavigationTool(server, options.logger, "browser_reload", "Reload the active tab.", async ({ lean, observeMode }) => {
    const navigation = await browser.reload();
    registry.invalidate("Reload replaced the current page state.");
    return observationResult({ navigation }, await observeCurrent(browser, observer), "Reloaded the active tab.", lean, observeMode);
  });

  server.registerTool(
    "browser_observe",
    {
      title: "Observe page",
      description:
        "Inspect the active page and return visible semantic elements, forms, tables, dialogs, menus, notifications, and fresh opaque element references.",
      inputSchema: observeOptionsSchema,
    },
    guard(options.logger, "browser_observe", async ({ lean, observeMode, limit, verbose }) => {
      const observation = await observeCurrent(browser, observer);
      return observationResult({}, observation, undefined, lean, observeMode, limit, verbose);
    }),
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click element",
      description: "Click an element; force enables a controlled DOM-click fallback for hidden or obscured controls.",
      inputSchema: clickInputSchema,
    },
    guard(options.logger, "browser_click", async ({ force, lean, observeMode, limit, verbose, ...target }) => actionResult(await interactions.click(target, force), lean, observeMode, limit, verbose)),
  );

  server.registerTool(
    "browser_fill",
    {
      title: "Fill input",
      description: "Replace an input value while dispatching framework-compatible input and change events.",
      inputSchema: fillInputSchema,
    },
    guard(options.logger, "browser_fill", async ({ value, commit, lean, observeMode, limit, verbose, ...target }) => actionResult(await interactions.fill(target, value, commit), lean, observeMode, limit, verbose)),
  );

  server.registerTool(
    "browser_clear",
    {
      title: "Clear input",
      description: "Clear a text-capable element and optionally commit the change.",
      inputSchema: clearInputSchema,
    },
    guard(options.logger, "browser_clear", async ({ commit, lean, observeMode, ...target }) => actionResult(await interactions.clear(target, commit), lean, observeMode)),
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type text",
      description: "Focus an observed text-capable element and type text using browser keyboard events.",
      inputSchema: typeInputSchema,
    },
    guard(options.logger, "browser_type", async ({ text, lean, observeMode, limit, verbose, ...target }) => actionResult(await interactions.type(target, text), lean, observeMode, limit, verbose)),
  );

  server.registerTool(
    "browser_press",
    {
      title: "Press key",
      description: "Focus an observed element and press a supported keyboard key.",
      inputSchema: pressInputSchema,
    },
    guard(options.logger, "browser_press", async ({ key, lean, observeMode, ...target }) => actionResult(await interactions.press(target, key), lean, observeMode)),
  );

  server.registerTool(
    "browser_select",
    {
      title: "Select option",
      description: "Select a native option by value or visible text, or use accessible keyboard selection for a custom combobox.",
      inputSchema: selectInputSchema,
    },
    guard(options.logger, "browser_select", async ({ value, lean, observeMode, ...target }) => actionResult(await interactions.select(target, value), lean, observeMode)),
  );

  server.registerTool(
    "browser_check",
    {
      title: "Check control",
      description: "Check a checkbox, radio control, or switch if it is not already checked.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "browser_check", async ({ lean, observeMode, ...target }) => actionResult(await interactions.setChecked(target, true), lean, observeMode)),
  );

  server.registerTool(
    "browser_uncheck",
    {
      title: "Uncheck control",
      description: "Uncheck a checkbox, radio control, or switch if it is currently checked.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "browser_uncheck", async ({ lean, observeMode, ...target }) => actionResult(await interactions.setChecked(target, false), lean, observeMode)),
  );

  server.registerTool(
    "browser_hover",
    {
      title: "Hover element",
      description: "Hover over an observed element and return the resulting semantic state.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "browser_hover", async ({ lean, observeMode, ...target }) => actionResult(await interactions.hover(target), lean, observeMode)),
  );

  server.registerTool(
    "browser_focus",
    {
      title: "Focus element",
      description: "Focus an observed element and return the resulting semantic state.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "browser_focus", async ({ lean, observeMode, ...target }) => actionResult(await interactions.focus(target), lean, observeMode)),
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
      return observationResult({ wait: result }, observation, `Wait condition ${result.condition} met.`, request.lean, request.observeMode);
    }),
  );

  server.registerTool(
    "browser_wait_for_element",
    {
      title: "Wait for semantic element",
      description: "Wait until an element matching a role and/or accessible name appears, then return a fresh observation.",
      inputSchema: waitForElementInputSchema,
    },
    guard(options.logger, "browser_wait_for_element", async ({ role, name, timeout, lean, observeMode }) => {
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
      return observationResult({ element }, observation, `Found [${element.ref}] ${element.role}.`, lean, observeMode);
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
      inputSchema: observeOptionsSchema,
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
      inputSchema: observeOptionsSchema,
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

  server.registerTool(
    "get_notifications",
    {
      title: "Get notifications",
      description: "Return the current page's visible semantic notifications in a compact form.",
      inputSchema: observeOptionsSchema,
    },
    guard(options.logger, "get_notifications", async () => {
      const observation = await observeCurrent(browser, observer);
      return success({ notifications: observation.notifications });
    }),
  );

  server.registerTool(
    "construct_locator",
    {
      title: "Construct locator",
      description: "Return ranked locator candidates for an observed element or descriptive details.",
      inputSchema: constructLocatorInputSchema,
    },
    guard(options.logger, "construct_locator", async ({ ref, details }) => {
      if (!ref) {
        return success({ candidates: [], message: `No observed ref was supplied for details=${JSON.stringify(details)}. Call observe first.` });
      }
      const entry = registry.resolve(ref);
      const frame = await browser.requireActiveFrame();
      const matchCount = await countLocatorMatches(frame, entry.locator);
      return success({ candidates: [{ strategy: entry.locator.strategy, value: entry.locator.value, matchCount, quality: "observed-element" }] });
    }),
  );

  server.registerTool(
    "assert",
    {
      title: "Assert element state",
      description: "Assert a compact state condition against an element ref or locator.",
      inputSchema: assertInputSchema,
    },
    guard(options.logger, "assert", async ({ condition, expected, ...target }) => {
      const frame = await browser.requireActiveFrame();
      const handle = target.ref
        ? await registry.resolveHandle(frame, target.ref)
        : await registry.resolveLocator(frame, target.locator!);
      try {
        const actual = await handle.evaluate((element) => ({
          visible: (() => { const rect = (element as HTMLElement).getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })(),
          enabled: !(element as HTMLElement).matches(":disabled") && element.getAttribute("aria-disabled") !== "true",
          checked: (element as HTMLInputElement).checked ?? element.getAttribute("aria-checked") === "true",
          selected: (element as HTMLOptionElement).selected ?? element.getAttribute("aria-selected") === "true",
          text: element.textContent?.trim() ?? "",
          value: "value" in element ? String((element as HTMLInputElement).value) : "",
        }));
        const actualValue = condition === "text_contains" || condition === "text_equals" ? actual.text : condition === "value_equals" ? actual.value : actual[condition as "visible" | "enabled" | "checked" | "selected"];
        const passed = condition === "exists" ? true : condition === "text_contains" ? actual.text.includes(String(expected ?? "")) : condition === "text_equals" ? actual.text === String(expected ?? "") : condition === "value_equals" ? actual.value === String(expected ?? "") : actualValue === expected;
        return success({ passed, condition, expected, actual: actualValue });
      } finally {
        await handle.dispose();
      }
    }),
  );

  server.registerTool(
    "send_keys",
    {
      title: "Send keys",
      description: "Selenium-style alias for browser_type: focus an element and send text using keyboard events.",
      inputSchema: typeInputSchema,
    },
    guard(options.logger, "send_keys", async ({ text, lean, observeMode, ...target }) => actionResult(await interactions.type(target, text), lean, observeMode)),
  );

  server.registerTool(
    "press_key",
    {
      title: "Press key",
      description: "Selenium-style alias for browser_press.",
      inputSchema: pressInputSchema,
    },
    guard(options.logger, "press_key", async ({ key, lean, observeMode, ...target }) => actionResult(await interactions.press(target, key), lean, observeMode)),
  );

  server.registerTool(
    "clear",
    {
      title: "Clear input",
      description: "Selenium-style alias for browser_clear.",
      inputSchema: clearInputSchema,
    },
    guard(options.logger, "clear", async ({ commit, lean, observeMode, ...target }) => actionResult(await interactions.clear(target, commit), lean, observeMode)),
  );

  server.registerTool(
    "click",
    {
      title: "Click element",
      description: "Selenium-style alias for browser_click.",
      inputSchema: clickInputSchema,
    },
    guard(options.logger, "click", async ({ force, lean, observeMode, limit, verbose, ...target }) => actionResult(await interactions.click(target, force), lean, observeMode, limit, verbose)),
  );

  server.registerTool(
    "fill",
    {
      title: "Fill input",
      description: "Selenium-compatible replacement-value input operation.",
      inputSchema: fillInputSchema,
    },
    guard(options.logger, "fill", async ({ value, commit, lean, observeMode, limit, verbose, ...target }) => actionResult(await interactions.fill(target, value, commit), lean, observeMode, limit, verbose)),
  );

  server.registerTool(
    "select",
    {
      title: "Select option",
      description: "Selenium-style alias for browser_select.",
      inputSchema: selectInputSchema,
    },
    guard(options.logger, "select", async ({ value, lean, observeMode, limit, verbose, ...target }) => actionResult(await interactions.select(target, value), lean, observeMode, limit, verbose)),
  );

  server.registerTool(
    "check",
    {
      title: "Check control",
      description: "Selenium-style alias for browser_check.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "check", async ({ lean, observeMode, limit, verbose, ...target }) => actionResult(await interactions.setChecked(target, true), lean, observeMode, limit, verbose)),
  );

  server.registerTool(
    "uncheck",
    {
      title: "Uncheck control",
      description: "Selenium-style alias for browser_uncheck.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "uncheck", async ({ lean, observeMode, limit, verbose, ...target }) => actionResult(await interactions.setChecked(target, false), lean, observeMode, limit, verbose)),
  );

  server.registerTool(
    "hover",
    {
      title: "Hover element",
      description: "Selenium-style alias for browser_hover.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "hover", async ({ lean, observeMode, limit, verbose, ...target }) => actionResult(await interactions.hover(target), lean, observeMode, limit, verbose)),
  );

  server.registerTool(
    "focus",
    {
      title: "Focus element",
      description: "Selenium-style alias for browser_focus.",
      inputSchema: refInputSchema,
    },
    guard(options.logger, "focus", async ({ lean, observeMode, limit, verbose, ...target }) => actionResult(await interactions.focus(target), lean, observeMode, limit, verbose)),
  );

  server.registerTool(
    "switch_to_default_content",
    {
      title: "Switch to default content",
      description: "Switch from a child iframe back to the active page's main frame.",
      inputSchema: observeOptionsSchema,
    },
    guard(options.logger, "switch_to_default_content", async () => {
      registry.invalidate("The active frame changed to the main frame.");
      return success({ frame: await browser.switchToDefaultContent() });
    }),
  );

  return server;
}

function registerNavigationTool(
  server: McpServer,
  logger: Logger,
  name: string,
  description: string,
  handler: (options: { lean: boolean; observeMode: "none" | "diff" | "full" }) => Promise<CallToolResult>,
): void {
  server.registerTool(name, {
    title: name.replace("browser_", "").replace(/_/g, " "),
    description,
    inputSchema: observeOptionsSchema,
  }, guard(logger, name, handler));
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
  lean = true,
  observeMode: "none" | "diff" | "full" = "none",
  limit = 25,
  verbose = false,
) {
  const serializable = toSerializableObservation(observation);
  if (lean || observeMode !== "full") {
    return success({
      ...extra,
      page: observation.page,
      state: observation.state,
      interactables: observation.interactables.slice(0, limit).map((element) => ({
        ref: element.ref,
        role: element.role,
        name: element.name,
        text: element.text,
        enabled: element.enabled,
        checked: element.checked,
        selected: element.selected,
        ...(verbose ? { bounds: element.bounds, inViewport: element.inViewport } : {}),
      })),
      truncated: observation.interactables.length > limit,
    }, summary ?? renderObservation(observation));
  }
  return success(
    { ...extra, observation: serializable },
    summary ? `${summary}\n\n${renderObservation(observation)}` : renderObservation(observation),
  );
}

function actionResult(
  result: Awaited<ReturnType<InteractionService["click"]>>,
  lean = true,
  observeMode: "none" | "diff" | "full" = "none",
  limit = 25,
  verbose = false,
) {
  const summary = `${capitalize(result.action)} succeeded for ${result.ref}.${result.stateChanged ? " Page state changed." : ""}`;
  if (lean || observeMode !== "full") {
    return success({
      action: result.action,
      ref: result.ref,
      stateChanged: result.stateChanged,
      url: result.observation.page.url,
      title: result.observation.page.title,
      ...(result.readBackValue === undefined ? {} : { readBackValue: result.readBackValue }),
    }, summary);
  }

  return observationResult(
    { action: result.action, ref: result.ref, stateChanged: result.stateChanged },
    result.observation,
    summary,
    lean,
    observeMode,
    limit,
    verbose,
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

async function countLocatorMatches(
  frame: Pick<Frame, "$" | "$$">,
  locator: { strategy: "css" | "xpath"; value: string },
): Promise<number> {
  if (locator.strategy === "css") {
    return (await frame.$$(locator.value)).length;
  }
  const handles = await frame.$$(`xpath/${locator.value}`);
  await Promise.all(handles.map((handle) => handle.dispose()));
  return handles.length;
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
