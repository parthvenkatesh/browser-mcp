import type { ElementHandle } from "puppeteer-core";
import type { DocumentContext } from "./DomAnalyzer.js";

import type {
  ElementFingerprint,
  ElementLocator,
  ElementRef,
  Interactable,
  RegisteredElement,
  SemanticRole,
} from "./SemanticModel.js";

export interface ObservationContext {
  /** Useful when one registry is shared between more than one page. */
  pageId?: string;
  /** An optional document/state marker supplied by the caller. */
  stateId?: string;
}

export interface RegisterElementInput {
  semantic: Omit<Interactable, "ref">;
  locator: ElementLocator;
  backendNodeId?: number;
  /** `e` for interactables, `r` for table rows. */
  prefix?: string;
}

export interface InvalidatedElement {
  entry: RegisteredElement;
  reason: string;
  invalidatedAt: number;
}

/** Base class for errors that a tool can turn into a useful MCP error. */
export class ElementReferenceError extends Error {
  readonly ref: string;
  readonly code: "UNKNOWN_ELEMENT_REFERENCE" | "STALE_ELEMENT_REFERENCE";

  constructor(
    code: "UNKNOWN_ELEMENT_REFERENCE" | "STALE_ELEMENT_REFERENCE",
    ref: string,
    message: string,
  ) {
    super(message);
    this.name = "ElementReferenceError";
    this.code = code;
    this.ref = ref;
  }
}

export class UnknownElementReferenceError extends ElementReferenceError {
  constructor(ref: string) {
    super(
      "UNKNOWN_ELEMENT_REFERENCE",
      ref,
      `Unknown element ref=${ref}. Call browser_observe to obtain an element reference.`,
    );
    this.name = "UnknownElementReferenceError";
  }
}

export class StaleElementReferenceError extends ElementReferenceError {
  readonly reason: string;

  constructor(ref: string, reason: string) {
    super(
      "STALE_ELEMENT_REFERENCE",
      ref,
      `Element ref=${ref} is stale. ${reason} Call browser_observe to obtain fresh element references.`,
    );
    this.name = "StaleElementReferenceError";
    this.reason = reason;
  }
}

/**
 * Keeps refs opaque and one-shot relative to the latest observation. Ref
 * values are never recycled, so an old `e1` can never accidentally point to a
 * new element after a re-observation.
 */
export class ElementRegistry {
  private readonly active = new Map<ElementRef, RegisteredElement>();
  private readonly invalidated = new Map<ElementRef, InvalidatedElement>();
  private readonly nextByPrefix = new Map<string, number>();
  private currentEpoch = 0;
  private currentContext: ObservationContext | undefined;

  /**
   * A bounded history lets us distinguish stale refs from refs that were never
   * issued, without growing indefinitely during long-running server sessions.
   */
  constructor(private readonly maxInvalidatedEntries = 2_000) {}

  get epoch(): number {
    return this.currentEpoch;
  }

  get context(): Readonly<ObservationContext> | undefined {
    return this.currentContext;
  }

  /** Starts a new reference epoch and invalidates every prior active ref. */
  beginObservation(context?: ObservationContext): number {
    this.retireActive(
      "A newer browser_observe call replaced the current element references.",
    );
    this.currentEpoch += 1;
    this.currentContext = context;
    return this.currentEpoch;
  }

  /**
   * Invalidate refs following navigation, a major client-side state change, or
   * an action where the caller cannot safely prove the DOM stayed stable.
   */
  invalidate(
    reason = "The page or application state changed after the previous observation.",
  ): void {
    this.retireActive(reason);
    this.currentEpoch += 1;
  }

  register(input: RegisterElementInput): RegisteredElement {
    if (this.currentEpoch === 0) {
      this.beginObservation();
    }

    const prefix = normalizePrefix(input.prefix ?? "e");
    const next = (this.nextByPrefix.get(prefix) ?? 0) + 1;
    this.nextByPrefix.set(prefix, next);
    const ref = `${prefix}${next}`;
    const semantic: Interactable = { ...input.semantic, ref };
    const entry: RegisteredElement = {
      ref,
      epoch: this.currentEpoch,
      observedAt: Date.now(),
      role: semantic.role,
      name: semantic.name,
      visible: semantic.visible,
      enabled: semantic.enabled,
      backendNodeId: input.backendNodeId,
      selector: input.locator.value,
      locator: input.locator,
      semantic,
    };

    this.active.set(ref, entry);
    return entry;
  }

  /** Resolve a ref to internal semantic/locator metadata. */
  resolve(ref: string): RegisteredElement {
    const active = this.active.get(ref);
    if (active) {
      return active;
    }

    const retired = this.invalidated.get(ref);
    if (retired) {
      throw new StaleElementReferenceError(ref, retired.reason);
    }

    throw new UnknownElementReferenceError(ref);
  }

  /** Returns only currently valid records; callers cannot mutate the registry. */
  entries(): ReadonlyMap<ElementRef, RegisteredElement> {
    return new Map(this.active);
  }

  has(ref: string): boolean {
    return this.active.has(ref);
  }

  /**
   * Re-find an observed node and verify its immutable semantic fingerprint.
   * This deliberately throws a stale error rather than silently acting on an
   * equally-shaped replacement node.
   */
  async resolveHandle(
    page: DocumentContext,
    ref: string,
  ): Promise<ElementHandle<Element>> {
    const entry = this.resolve(ref);
    const handle = await findByLocator(page, entry.locator);
    if (!handle) {
      this.markEntryStale(
        entry,
        "The observed element is no longer present at its recorded location.",
      );
      throw new StaleElementReferenceError(
        ref,
        "The observed element is no longer present at its recorded location.",
      );
    }

    let matches = false;
    try {
      const actual = await handle.evaluate((element) => {
        const html = element as HTMLElement;
        const explicitRole = html.getAttribute("role")?.trim().toLowerCase();
        const tagName = element.tagName.toLowerCase();
        let nativeRole = "other";
        if (tagName === "button" || tagName === "summary") nativeRole = "button";
        else if (tagName === "a" && html.hasAttribute("href")) nativeRole = "link";
        else if (tagName === "textarea" || html.isContentEditable) nativeRole = "textbox";
        else if (tagName === "select") nativeRole = "combobox";
        else if (tagName === "option") nativeRole = "option";
        else if (tagName === "tr") nativeRole = "row";
        else if (tagName === "input") {
          const type = (html as HTMLInputElement).type.toLowerCase();
          if (type === "checkbox") nativeRole = "checkbox";
          else if (type === "radio") nativeRole = "radio";
          else if (type === "range") nativeRole = "slider";
          else if (type === "number") nativeRole = "spinbutton";
          else if (type === "search") nativeRole = "searchbox";
          else nativeRole = "textbox";
        }

        let name = html.getAttribute("aria-label")?.trim();
        if (!name) {
          const labelledBy = html.getAttribute("aria-labelledby");
          if (labelledBy) {
            name = labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ")
              .trim();
          }
        }
        if (
          !name &&
          (html instanceof HTMLInputElement ||
            html instanceof HTMLTextAreaElement ||
            html instanceof HTMLSelectElement)
        ) {
          name = Array.from(html.labels ?? [])
            .map((item) => item.textContent ?? "")
            .join(" ")
            .trim();
        }
        if (!name) {
          name =
            html.getAttribute("title")?.trim() ||
            html.getAttribute("placeholder")?.trim() ||
            html.innerText?.trim() ||
            undefined;
        }

        return {
          connected: element.isConnected,
          tagName,
          role: explicitRole || nativeRole,
          name,
          inputType:
            html instanceof HTMLInputElement ? html.type.toLowerCase() : undefined,
          placeholder: html.getAttribute("placeholder") ?? undefined,
        };
      });
      matches = fingerprintDataMatches(actual, entry.locator.fingerprint);
    } catch {
      matches = false;
    }

    if (!matches) {
      await safelyDispose(handle);
      this.markEntryStale(
        entry,
        "A DOM update replaced the observed element with a different element.",
      );
      throw new StaleElementReferenceError(
        ref,
        "A DOM update replaced the observed element with a different element.",
      );
    }

    return handle;
  }

  /** Alias useful to action services that prefer explicit naming. */
  getHandle(page: DocumentContext, ref: string): Promise<ElementHandle<Element>> {
    return this.resolveHandle(page, ref);
  }

  /** Resolve a caller-supplied locator only when it identifies one element. */
  async resolveLocator(page: DocumentContext, locator: Pick<ElementLocator, "strategy" | "value">): Promise<ElementHandle<Element>> {
    const handles = await findAllByLocator(page, locator);
    if (handles.length === 0) {
      throw new ElementReferenceError(
        "UNKNOWN_ELEMENT_REFERENCE",
        locator.value,
        `Locator did not match any element: ${locator.strategy}=${JSON.stringify(locator.value)}.`,
      );
    }
    if (handles.length > 1) {
      await Promise.all(handles.map((handle) => safelyDispose(handle)));
      throw new ElementReferenceError(
        "UNKNOWN_ELEMENT_REFERENCE",
        locator.value,
        `Locator matched ${handles.length} elements and is ambiguous: ${locator.strategy}=${JSON.stringify(locator.value)}.`,
      );
    }
    return handles[0]!;
  }

  private retireActive(reason: string): void {
    const invalidatedAt = Date.now();
    for (const [ref, entry] of this.active) {
      this.invalidated.set(ref, { entry, reason, invalidatedAt });
    }
    this.active.clear();
    this.trimInvalidatedHistory();
  }

  private markEntryStale(entry: RegisteredElement, reason: string): void {
    this.active.delete(entry.ref);
    this.invalidated.set(entry.ref, {
      entry,
      reason,
      invalidatedAt: Date.now(),
    });
    this.trimInvalidatedHistory();
  }

  private trimInvalidatedHistory(): void {
    while (this.invalidated.size > this.maxInvalidatedEntries) {
      const oldest = this.invalidated.keys().next().value as string | undefined;
      if (!oldest) {
        return;
      }
      this.invalidated.delete(oldest);
    }
  }
}

/** Best-effort element state useful to interaction handlers after resolution. */
export interface ResolvedElementState {
  connected: boolean;
  visible: boolean;
  enabled: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

export async function inspectElement(
  handle: ElementHandle<Element>,
): Promise<ResolvedElementState> {
  return handle.evaluate((element) => {
    const html = element as HTMLElement;
    const rect = html.getBoundingClientRect();
    const style = window.getComputedStyle(html);
    const visible =
      element.isConnected &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      Number.parseFloat(style.opacity || "1") > 0.01 &&
      rect.width > 0 &&
      rect.height > 0;
    const disabled =
      html.matches(":disabled") ||
      html.getAttribute("aria-disabled") === "true" ||
      Boolean(html.closest("fieldset[disabled]"));

    return {
      connected: element.isConnected,
      visible,
      enabled: !disabled,
      bounds:
        rect.width > 0 || rect.height > 0
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : undefined,
    };
  });
}

function normalizePrefix(value: string): string {
  const normalized = value.replace(/[^a-z]/gi, "").toLowerCase();
  return normalized || "e";
}

async function findByLocator(
  page: DocumentContext,
  locator: ElementLocator,
): Promise<ElementHandle<Element> | null> {
  const primary = (await findAllByLocator(page, locator))[0];
  if (primary) {
    return primary;
  }

  if (!locator.fallback || locator.fallback === locator.value) {
    return null;
  }

  return (await findAllByLocator(page, { strategy: "css", value: locator.fallback }))[0] ?? null;
}

async function findAllByLocator(
  page: DocumentContext,
  locator: Pick<ElementLocator, "strategy" | "value">,
): Promise<ElementHandle<Element>[]> {
  if (locator.strategy === "xpath") {
    return page.$$(`xpath/${locator.value}`);
  }
  return page.$$(locator.value);
}

async function safelyDispose(handle: ElementHandle<Element>): Promise<void> {
  try {
    await handle.dispose();
  } catch {
    // A detached execution context is exactly the stale state being handled.
  }
}

function fingerprintDataMatches(
  actual: {
    connected: boolean;
    tagName: string;
    role: string;
    name?: string;
    inputType?: string;
    placeholder?: string;
  },
  expected: ElementFingerprint,
): boolean {
  if (!actual.connected) {
    return false;
  }

  if (actual.tagName.toLowerCase() !== expected.tagName.toLowerCase()) {
    return false;
  }

  if (normalizeRole(actual.role) !== expected.role) {
    return false;
  }

  if (expected.inputType) {
    if (actual.inputType !== expected.inputType.toLowerCase()) {
      return false;
    }
  }

  if (expected.placeholder !== undefined) {
    if (normalizeText(actual.placeholder) !== normalizeText(expected.placeholder)) {
      return false;
    }
  }

  if (expected.name) {
    if (normalizeText(actual.name) !== normalizeText(expected.name)) {
      return false;
    }
  }

  return true;
}

function normalizeRole(role: string): SemanticRole {
  switch (role) {
    case "button":
    case "link":
    case "textbox":
    case "searchbox":
    case "checkbox":
    case "radio":
    case "combobox":
    case "listbox":
    case "option":
    case "slider":
    case "spinbutton":
    case "switch":
    case "tab":
    case "menuitem":
    case "menuitemcheckbox":
    case "menuitemradio":
    case "treeitem":
    case "gridcell":
    case "row":
      return role;
    default:
      return "other";
  }
}


function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
