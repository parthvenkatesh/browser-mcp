import type { ElementHandle, Frame, Page } from "puppeteer-core";

import { inspectElement } from "../exploration/ElementRegistry.js";
import type { ElementRegistry } from "../exploration/ElementRegistry.js";
import type {
  ElementLocator,
  Observation,
  RegisteredElement,
  SemanticRole,
} from "../exploration/SemanticModel.js";
import type { Observer } from "../exploration/Observer.js";
import { BrowserMcpError } from "../mcp/errors.js";

export interface ActivePageProvider {
  requireActivePage(): Promise<Page>;
  requireActiveFrame(): Promise<Frame>;
}

export interface InteractionServiceOptions {
  /** Time to wait for an observable result after a user action. */
  postActionTimeoutMs?: number;
}

export interface ActionResult {
  action: string;
  ref: string;
  stateChanged: boolean;
  observation: Observation;
}

export interface ElementTarget {
  ref?: string;
  locator?: Pick<ElementLocator, "strategy" | "value">;
}

/**
 * Implements semantic actions using element references. CSS and CDP details
 * remain inside ElementRegistry; callers never supply a locator.
 */
export class InteractionService {
  private readonly postActionTimeoutMs: number;

  public constructor(
    private readonly pages: ActivePageProvider,
    private readonly observer: Observer,
    private readonly registry: ElementRegistry,
    options: InteractionServiceOptions = {},
  ) {
    this.postActionTimeoutMs = options.postActionTimeoutMs ?? 1_250;
  }

  public async click(target: ElementTarget): Promise<ActionResult> {
    return this.withElement(target, "click", async (page, handle) => {
      await scrollIntoView(handle);
      await handle.click();
    });
  }

  public async fill(target: ElementTarget, value: string): Promise<ActionResult> {
    return this.withElement(target, "fill", async (page, handle, entry) => {
      await assertTextEntry(entry, handle, targetLabel(target));
      await scrollIntoView(handle);
      await handle.focus();

      const kind = await handle.evaluate((element) => ({
        contentEditable: (element as HTMLElement).isContentEditable,
        tagName: element.tagName.toLowerCase(),
      }));

      if (kind.contentEditable) {
        await page.keyboard.down("Control");
        await page.keyboard.press("A");
        await page.keyboard.up("Control");
        await page.keyboard.type(value);
        return;
      }

      if (kind.tagName !== "input" && kind.tagName !== "textarea") {
        throw new BrowserMcpError(
          "ELEMENT_NOT_FILLABLE",
          `Unable to fill ${targetLabel(target)}. The element is not a text input.`,
        );
      }

      await handle.evaluate((element, nextValue) => {
        const input = element as HTMLInputElement | HTMLTextAreaElement;
        const prototype = input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) {
          setter.call(input, nextValue);
        } else {
          input.value = nextValue;
        }

        input.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertText",
          data: nextValue,
        }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, value);
    });
  }

  public async type(target: ElementTarget, text: string): Promise<ActionResult> {
    return this.withElement(target, "type", async (_page, handle, entry) => {
      await assertTextEntry(entry, handle, targetLabel(target));
      await scrollIntoView(handle);
      await handle.focus();
      await handle.type(text);
    });
  }

  public async press(target: ElementTarget, key: string): Promise<ActionResult> {
    return this.withElement(target, "press", async (page, handle) => {
      await scrollIntoView(handle);
      await handle.focus();
      await page.keyboard.press(key as Parameters<Page["keyboard"]["press"]>[0]);
    });
  }

  public async select(target: ElementTarget, value: string): Promise<ActionResult> {
    return this.withElement(target, "select", async (page, handle, entry) => {
      const ref = targetLabel(target);
      const role = await interactionRole(handle, entry);
      if (role !== "combobox" && role !== "listbox") {
        throw new BrowserMcpError(
          "ELEMENT_NOT_SELECTABLE",
          `Unable to select ref=${ref}. The element is not a select or combobox.`,
        );
      }
      await scrollIntoView(handle);

      const nativeResult = await handle.evaluate((element, desiredValue) => {
        if (!(element instanceof HTMLSelectElement)) {
          return { native: false, selected: false };
        }

        const option = Array.from(element.options).find(
          (candidate) => candidate.value === desiredValue || candidate.text.trim() === desiredValue,
        );
        if (!option) {
          return { native: true, selected: false };
        }

        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        if (setter) {
          setter.call(element, option.value);
        } else {
          element.value = option.value;
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { native: true, selected: true };
      }, value);

      if (nativeResult.native) {
        if (!nativeResult.selected) {
          throw new BrowserMcpError(
            "OPTION_NOT_FOUND",
            `No option with value or visible text ${JSON.stringify(value)} was found for ref=${ref}.`,
          );
        }
        return;
      }

      // A custom ARIA combobox has no reliable generic value setter. Opening
      // it and using real keyboard input works with most accessible widgets.
      await handle.click();
      await page.keyboard.type(value);
      await page.keyboard.press("Enter");
    });
  }

  public async setChecked(target: ElementTarget, checked: boolean): Promise<ActionResult> {
    return this.withElement(target, checked ? "check" : "uncheck", async (_page, handle, entry) => {
      const ref = targetLabel(target);
      const role = await interactionRole(handle, entry);
      if (!isCheckable(role)) {
        throw new BrowserMcpError(
          "ELEMENT_NOT_CHECKABLE",
          `Unable to ${checked ? "check" : "uncheck"} ref=${ref}. The element is not a checkbox, radio, or switch.`,
        );
      }
      await scrollIntoView(handle);
      const current = await handle.evaluate((element) => {
        const html = element as HTMLInputElement;
        return html.checked ?? element.getAttribute("aria-checked") === "true";
      });
      if (current !== checked) {
        await handle.click();
      }
    });
  }

  public async hover(target: ElementTarget): Promise<ActionResult> {
    return this.withElement(target, "hover", async (_page, handle) => {
      await scrollIntoView(handle);
      await handle.hover();
    });
  }

  public async focus(target: ElementTarget): Promise<ActionResult> {
    return this.withElement(target, "focus", async (_page, handle) => {
      await scrollIntoView(handle);
      await handle.focus();
    });
  }

  private async withElement(
    target: ElementTarget,
    action: string,
    execute: (page: Page, handle: ElementHandle<Element>, entry: RegisteredElement | undefined) => Promise<void>,
  ): Promise<ActionResult> {
    const page = await this.pages.requireActivePage();
    const frame = await this.pages.requireActiveFrame();
    const before = await pageFingerprint(frame);
    const ref = targetLabel(target);
    const entry = target.ref ? this.registry.resolve(target.ref) : undefined;
    const handle = target.ref
      ? await this.registry.resolveHandle(frame, target.ref)
      : await this.registry.resolveLocator(frame, target.locator!);

    try {
      await assertInteractable(handle, ref);
      await execute(page, handle, entry);
    } finally {
      await safelyDispose(handle);
    }

    const stateChanged = await waitForMeaningfulChange(frame, before, this.postActionTimeoutMs);
    const observation = await this.observer.observe(frame);
    return { action, ref, stateChanged, observation };
  }
}

async function assertInteractable(handle: ElementHandle<Element>, ref: string): Promise<void> {
  const state = await inspectElement(handle);
  if (!state.connected) {
    throw new BrowserMcpError(
      "STALE_ELEMENT_REFERENCE",
      `Element ref=${ref} is no longer attached. Call browser_observe to obtain fresh element references.`,
    );
  }
  if (!state.visible) {
    throw new BrowserMcpError(
      "ELEMENT_NOT_VISIBLE",
      `Unable to interact with ref=${ref}. The element is not currently visible.`,
    );
  }
  if (!state.enabled) {
    throw new BrowserMcpError(
      "ELEMENT_DISABLED",
      `Unable to interact with ref=${ref}. The element exists but is currently disabled.`,
    );
  }
}

async function assertTextEntry(entry: RegisteredElement | undefined, handle: ElementHandle<Element>, ref: string): Promise<void> {
  const role = await interactionRole(handle, entry);
  if (!isTextRole(role)) {
    throw new BrowserMcpError(
      "ELEMENT_NOT_FILLABLE",
      `Unable to type into ${ref}. The element is not a text-capable input.`,
    );
  }
}

async function interactionRole(handle: ElementHandle<Element>, entry?: RegisteredElement): Promise<SemanticRole> {
  return entry?.role ?? await handle.evaluate((element): SemanticRole => {
    const html = element as HTMLElement;
    if (html instanceof HTMLTextAreaElement || html.isContentEditable) return "textbox";
    if (html instanceof HTMLInputElement && html.type === "number") return "spinbutton";
    if (html instanceof HTMLInputElement) return html.type === "search" ? "searchbox" : "textbox";
    if (html instanceof HTMLSelectElement) return "combobox";
    if (html.getAttribute("role") === "listbox") return "listbox";
    if (html.getAttribute("role") === "checkbox") return "checkbox";
    if (html.getAttribute("role") === "radio") return "radio";
    if (html.getAttribute("role") === "switch") return "switch";
    return "other";
  });
}

function targetLabel(target: ElementTarget): string {
  return target.ref ? `ref=${target.ref}` : `locator=${target.locator?.strategy}:${JSON.stringify(target.locator?.value)}`;
}

function isTextRole(role: SemanticRole): boolean {
  return ["textbox", "searchbox", "spinbutton"].includes(role);
}

function isCheckable(role: SemanticRole): boolean {
  return ["checkbox", "radio", "switch"].includes(role);
}

async function scrollIntoView(handle: ElementHandle<Element>): Promise<void> {
  await handle.evaluate((element) => {
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
  });
}

async function pageFingerprint(page: Pick<Frame, "evaluate">): Promise<string> {
  return page.evaluate(() => {
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]').length;
    const menus = document.querySelectorAll('[role="menu"], [role="listbox"]').length;
    const active = document.activeElement as HTMLElement | null;
    const text = document.body?.innerText?.replace(/\s+/g, " ").slice(0, 2_000) ?? "";
    return JSON.stringify({ href: location.href, title: document.title, dialogs, menus, active: active?.outerHTML.slice(0, 160), text });
  });
}

async function waitForMeaningfulChange(
  page: Pick<Frame, "evaluate" | "waitForFunction">,
  previous: string,
  timeout: number,
): Promise<boolean> {
  try {
    await page.waitForFunction((prior) => {
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]').length;
      const menus = document.querySelectorAll('[role="menu"], [role="listbox"]').length;
      const active = document.activeElement as HTMLElement | null;
      const text = document.body?.innerText?.replace(/\s+/g, " ").slice(0, 2_000) ?? "";
      const current = JSON.stringify({
        href: location.href,
        title: document.title,
        dialogs,
        menus,
        active: active?.outerHTML.slice(0, 160),
        text,
      });
      return current !== prior;
    }, { timeout }, previous);
    return true;
  } catch {
    return false;
  }
}

async function safelyDispose(handle: ElementHandle<Element>): Promise<void> {
  try {
    await handle.dispose();
  } catch {
    // It may already be gone after an in-page navigation.
  }
}
