import type { Page } from "puppeteer-core";
import type { DocumentContext } from "../exploration/DomAnalyzer.js";

import { inspectElement } from "../exploration/ElementRegistry.js";
import type { ElementRegistry } from "../exploration/ElementRegistry.js";
import type { ElementLocator } from "../exploration/SemanticModel.js";
import { BrowserMcpError } from "../mcp/errors.js";

export type WaitCondition =
  | "network_idle"
  | "navigation"
  | "element_visible"
  | "element_enabled"
  | "text_visible"
  | "text_hidden";

export interface WaitRequest {
  condition: WaitCondition;
  ref?: string;
  locator?: Pick<ElementLocator, "strategy" | "value">;
  text?: string;
  timeout: number;
}

/** CDP/DOM-driven waits; this deliberately has no exposed arbitrary sleep. */
export class WaitService {
  public constructor(private readonly registry: ElementRegistry) {}

  public async wait(page: Page, frame: DocumentContext, request: WaitRequest): Promise<{ condition: WaitCondition; met: true }> {
    switch (request.condition) {
      case "network_idle":
        await page.waitForNetworkIdle({ idleTime: 500, timeout: request.timeout });
        break;
      case "navigation":
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: request.timeout });
        break;
      case "element_visible":
        await this.waitForElementState(frame, request, request.timeout, "visible");
        break;
      case "element_enabled":
        await this.waitForElementState(frame, request, request.timeout, "enabled");
        break;
      case "text_visible":
        await frame.waitForFunction(
          (needle) => (document.body?.innerText ?? "").includes(needle),
          { timeout: request.timeout },
          requiredText(request),
        );
        break;
      case "text_hidden":
        await frame.waitForFunction(
          (needle) => !(document.body?.innerText ?? "").includes(needle),
          { timeout: request.timeout },
          requiredText(request),
        );
        break;
      default:
        throw new BrowserMcpError("INVALID_WAIT_CONDITION", "Unsupported browser wait condition.");
    }

    return { condition: request.condition, met: true };
  }

  private async waitForElementState(
    frame: DocumentContext,
    request: WaitRequest,
    timeout: number,
    expected: "visible" | "enabled",
  ): Promise<void> {
    const ref = request.ref;
    const entry = ref ? this.registry.resolve(ref) : undefined;
    const locator = entry
      ? { strategy: "css" as const, value: entry.selector }
      : request.locator;
    if (!locator) {
      throw new BrowserMcpError("INVALID_WAIT_REQUEST", `condition=${request.condition} requires ref or locator.`);
    }
    await frame.waitForFunction(
      (candidate, state) => {
        let element: HTMLElement | null;
        if (candidate.strategy === "xpath") {
          element = document.evaluate(candidate.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement | null;
        } else {
          element = document.querySelector(candidate.value) as HTMLElement | null;
        }
        if (!element || !element.isConnected) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible = style.display !== "none" && style.visibility !== "hidden" &&
          style.visibility !== "collapse" && Number.parseFloat(style.opacity || "1") > 0.01 &&
          rect.width > 0 && rect.height > 0;
        const enabled = !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true";
        return state === "visible" ? visible : enabled;
      },
      { timeout },
      locator,
      expected,
    );

    // Re-resolve after the condition is met. If a SPA replaced the matching
    // node, ElementRegistry deliberately reports stale rather than acting on it.
    const handle = ref
      ? await this.registry.resolveHandle(frame, ref)
      : await this.registry.resolveLocator(frame, locator);
    try {
      const state = await inspectElement(handle);
      if (expected === "visible" && !state.visible) {
        throw new BrowserMcpError("WAIT_CONDITION_NOT_MET", `Element ${ref ? `ref=${ref}` : `locator=${locator.value}`} is not visible.`);
      }
      if (expected === "enabled" && !state.enabled) {
        throw new BrowserMcpError("WAIT_CONDITION_NOT_MET", `Element ${ref ? `ref=${ref}` : `locator=${locator.value}`} is not enabled.`);
      }
    } finally {
      try {
        await handle.dispose();
      } catch {
        // Detached handles are handled by the registry on the next resolve.
      }
    }
  }
}

function requiredText(request: WaitRequest): string {
  if (!request.text) {
    throw new BrowserMcpError("INVALID_WAIT_REQUEST", `condition=${request.condition} requires text.`);
  }
  return request.text;
}
