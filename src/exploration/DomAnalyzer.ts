import type { Page } from "puppeteer-core";

import type {
  Bounds,
  ContainerRole,
  Notification,
  PageSummary,
  SemanticRole,
} from "./SemanticModel.js";

export interface DomAnalyzerOptions {
  maxInteractables?: number;
  maxTableRows?: number;
  maxTextLength?: number;
  /** Safety cap for a pathological page with millions of nodes. */
  maxCandidateNodes?: number;
}

export interface RawSemanticElement {
  selector: string;
  fallbackSelector?: string;
  tagName: string;
  role: SemanticRole;
  name?: string;
  text?: string;
  placeholder?: string;
  value?: string;
  inputType?: string;
  visible: boolean;
  inViewport: boolean;
  enabled: boolean;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  required?: boolean;
  readOnly?: boolean;
  bounds?: Bounds;
  parentSelector?: string;
  formSelector?: string;
  tableSelector?: string;
  rowSelector?: string;
}

export interface RawForm {
  id: string;
  selector: string;
  name?: string;
  visible: boolean;
  bounds?: Bounds;
  controlSelectors: string[];
}

export interface RawTableRow {
  selector: string;
  tagName: string;
  text?: string;
  visible: boolean;
  bounds?: Bounds;
  cells: Record<string, string>;
  actionSelectors: string[];
}

export interface RawTable {
  id: string;
  selector: string;
  name?: string;
  visible: boolean;
  bounds?: Bounds;
  columns: string[];
  rows: RawTableRow[];
  truncated?: boolean;
}

export interface RawContainer {
  id: string;
  selector: string;
  role: ContainerRole;
  name?: string;
  text?: string;
  visible: boolean;
  bounds?: Bounds;
  active?: boolean;
}

export interface RawPageAnalysis {
  page: PageSummary;
  elements: RawSemanticElement[];
  forms: RawForm[];
  tables: RawTable[];
  dialogs: RawContainer[];
  menus: RawContainer[];
  notifications: Notification[];
  stateInput: {
    dialogFingerprint: string;
    menuFingerprint: string;
    notificationFingerprint: string;
    structureFingerprint: string;
  };
}

const DEFAULT_OPTIONS: Required<DomAnalyzerOptions> = {
  maxInteractables: 250,
  maxTableRows: 25,
  maxTextLength: 800,
  maxCandidateNodes: 8_000,
};

/**
 * Collect semantic data in one page-context pass. The analyser prefers the
 * browser's computed accessibility node when Chrome exposes it, then falls
 * back to ARIA, labels, native control semantics, and visible DOM text.
 */
export async function analyzePage(
  page: Page,
  options: DomAnalyzerOptions = {},
): Promise<RawPageAnalysis> {
  const normalizedOptions = { ...DEFAULT_OPTIONS, ...options };
  return page.evaluate((input) => {
    type BrowserBounds = { x: number; y: number; width: number; height: number };
    type BrowserRole =
      | "button"
      | "link"
      | "textbox"
      | "searchbox"
      | "checkbox"
      | "radio"
      | "combobox"
      | "listbox"
      | "option"
      | "slider"
      | "spinbutton"
      | "switch"
      | "tab"
      | "menuitem"
      | "menuitemcheckbox"
      | "menuitemradio"
      | "treeitem"
      | "gridcell"
      | "row"
      | "other";
    type BrowserContainerRole =
      | "dialog"
      | "alertdialog"
      | "menu"
      | "drawer"
      | "popover"
      | "tooltip";
    type BrowserRawElement = {
      selector: string;
      fallbackSelector?: string;
      tagName: string;
      role: BrowserRole;
      name?: string;
      text?: string;
      placeholder?: string;
      value?: string;
      inputType?: string;
      visible: boolean;
      inViewport: boolean;
      enabled: boolean;
      checked?: boolean;
      selected?: boolean;
      expanded?: boolean;
      required?: boolean;
      readOnly?: boolean;
      bounds?: BrowserBounds;
      parentSelector?: string;
      formSelector?: string;
      tableSelector?: string;
      rowSelector?: string;
    };
    type BrowserRawForm = {
      id: string;
      selector: string;
      name?: string;
      visible: boolean;
      bounds?: BrowserBounds;
      controlSelectors: string[];
    };
    type BrowserRawTableRow = {
      selector: string;
      tagName: string;
      text?: string;
      visible: boolean;
      bounds?: BrowserBounds;
      cells: Record<string, string>;
      actionSelectors: string[];
    };
    type BrowserRawTable = {
      id: string;
      selector: string;
      name?: string;
      visible: boolean;
      bounds?: BrowserBounds;
      columns: string[];
      rows: BrowserRawTableRow[];
      truncated?: boolean;
    };
    type BrowserRawContainer = {
      id: string;
      selector: string;
      role: BrowserContainerRole;
      name?: string;
      text?: string;
      visible: boolean;
      bounds?: BrowserBounds;
      active?: boolean;
    };
    type BrowserNotification = {
      id: string;
      role: "alert" | "status" | "log" | "other";
      text: string;
      visible: boolean;
    };

    const normalizeText = (value: string | null | undefined, limit?: number): string => {
      const normalized = (value ?? "").replace(/\s+/g, " ").trim();
      if (!limit || normalized.length <= limit) return normalized;
      return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
    };

    const cssEscape = (value: string): string => {
      const css = window.CSS as { escape?: (input: string) => string };
      if (typeof css.escape === "function") return css.escape(value);
      return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
    };

    const attributeValue = (value: string): string =>
      value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\A ");

    const isUnique = (selector: string): boolean => {
      try {
        return document.querySelectorAll(selector).length === 1;
      } catch {
        return false;
      }
    };

    const selectorFor = (element: Element): string => {
      const html = element as HTMLElement;
      if (html.id) {
        const byId = `#${cssEscape(html.id)}`;
        if (isUnique(byId)) return byId;
      }

      const tag = element.tagName.toLowerCase();
      for (const attribute of ["data-testid", "data-test-id", "data-test", "data-cy"]) {
        const value = html.getAttribute(attribute);
        if (!value) continue;
        const selector = `${tag}[${attribute}="${attributeValue(value)}"]`;
        if (isUnique(selector)) return selector;
      }

      const name = html.getAttribute("name");
      if (name) {
        const selector = `${tag}[name="${attributeValue(name)}"]`;
        if (isUnique(selector)) return selector;
      }

      const ariaLabel = html.getAttribute("aria-label");
      if (ariaLabel) {
        const selector = `${tag}[aria-label="${attributeValue(ariaLabel)}"]`;
        if (isUnique(selector)) return selector;
      }

      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentHtml = current as HTMLElement;
        if (currentHtml.id) {
          const byId = `#${cssEscape(currentHtml.id)}`;
          if (isUnique(byId)) {
            parts.unshift(byId);
            break;
          }
        }

        const currentTag = current.tagName.toLowerCase();
        const parent: Element | null = current.parentElement;
        if (!parent) {
          parts.unshift(currentTag);
          break;
        }
        const siblings = (Array.from(parent.children) as Element[]).filter(
          (sibling) => sibling.tagName.toLowerCase() === currentTag,
        );
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${currentTag}:nth-of-type(${Math.max(index, 1)})`);
        current = parent;
      }

      return parts.join(" > ");
    };

    const fallbackSelectorFor = (element: Element): string | undefined => {
      const html = element as HTMLElement;
      const tag = element.tagName.toLowerCase();
      const ariaLabel = html.getAttribute("aria-label");
      if (ariaLabel) {
        const selector = `${tag}[aria-label="${attributeValue(ariaLabel)}"]`;
        if (isUnique(selector)) return selector;
      }
      const name = html.getAttribute("name");
      if (name) {
        const selector = `${tag}[name="${attributeValue(name)}"]`;
        if (isUnique(selector)) return selector;
      }
      return undefined;
    };

    const boundsFor = (element: Element): BrowserBounds | undefined => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return undefined;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };

    const isRendered = (element: Element): boolean => {
      const html = element as HTMLElement;
      if (html.hidden || html.getAttribute("aria-hidden") === "true") return false;
      const rect = html.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;

      let current: HTMLElement | null = html;
      while (current) {
        if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
        const style = window.getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity || "1") <= 0.01
        ) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    };

    const isInViewport = (element: Element): boolean => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      return (
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };

    const isObscuredAtCenter = (element: Element): boolean => {
      if (!isInViewport(element)) return false;
      const rect = (element as HTMLElement).getBoundingClientRect();
      const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
      const top = document.elementFromPoint(x, y);
      return Boolean(top && top !== element && !element.contains(top) && !top.contains(element));
    };

    const nativeRoleFor = (element: Element): BrowserRole => {
      const html = element as HTMLElement;
      const tag = element.tagName.toLowerCase();
      if (tag === "button" || tag === "summary") return "button";
      if (tag === "a" && html.hasAttribute("href")) return "link";
      if (tag === "textarea" || html.isContentEditable) return "textbox";
      if (tag === "select") return "combobox";
      if (tag === "option") return "option";
      if (tag === "tr") return "row";
      if (tag === "input") {
        const type = (html as HTMLInputElement).type.toLowerCase();
        if (type === "hidden") return "other";
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "search") return "searchbox";
        return "textbox";
      }
      return "other";
    };

    const normalizeRole = (role: string | undefined, fallback: BrowserRole): BrowserRole => {
      switch ((role ?? "").trim().toLowerCase()) {
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
          return (role ?? "").trim().toLowerCase() as BrowserRole;
        default:
          return fallback;
      }
    };

    const computedAccessibility = (element: Element): { role?: string; name?: string } => {
      type ComputedAccessibleNode = { role?: string; name?: string };
      type AccessibilityWindow = Window & {
        getComputedAccessibleNode?: (node: Element) => ComputedAccessibleNode | null;
      };
      const getter = (window as AccessibilityWindow).getComputedAccessibleNode;
      if (typeof getter !== "function") return {};
      try {
        const node = getter(element);
        return { role: node?.role, name: node?.name };
      } catch {
        return {};
      }
    };

    const accessibleNameFor = (element: Element, computedName?: string): string | undefined => {
      const html = element as HTMLElement;
      const fromAccessibility = normalizeText(computedName);
      if (fromAccessibility) return fromAccessibility;

      const ariaLabel = normalizeText(html.getAttribute("aria-label"));
      if (ariaLabel) return ariaLabel;
      const labelledBy = html.getAttribute("aria-labelledby");
      if (labelledBy) {
        const labelledText = normalizeText(
          labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" "),
        );
        if (labelledText) return labelledText;
      }
      if (
        html instanceof HTMLInputElement ||
        html instanceof HTMLTextAreaElement ||
        html instanceof HTMLSelectElement
      ) {
        const labels = normalizeText(
          Array.from(html.labels ?? [])
            .map((label) => label.innerText || label.textContent || "")
            .join(" "),
        );
        if (labels) return labels;
      }
      const closestLabel = html.closest("label");
      if (closestLabel) {
        const labelText = normalizeText(closestLabel.textContent);
        if (labelText) return labelText;
      }
      if (html instanceof HTMLInputElement && ["button", "submit", "reset"].includes(html.type)) {
        const inputValue = normalizeText(html.value);
        if (inputValue) return inputValue;
      }
      return (
        normalizeText(html.getAttribute("title")) ||
        normalizeText(html.getAttribute("alt")) ||
        normalizeText(html.getAttribute("placeholder")) ||
        normalizeText(html.innerText || html.textContent, 240) ||
        undefined
      );
    };

    const valueFor = (element: Element): string | undefined => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        const value = normalizeText(element.value, 240);
        return value || undefined;
      }
      return undefined;
    };

    const isEnabled = (element: Element): boolean => {
      const html = element as HTMLElement;
      return !(
        html.matches(":disabled") ||
        html.getAttribute("aria-disabled") === "true" ||
        Boolean(html.closest("fieldset[disabled], [aria-disabled=\"true\"]"))
      );
    };

    const isPotentiallyInteractive = (element: Element, role: BrowserRole): boolean => {
      const html = element as HTMLElement;
      const tag = element.tagName.toLowerCase();
      if (tag === "input" && (html as HTMLInputElement).type.toLowerCase() === "hidden") {
        return false;
      }
      if (role !== "other" && role !== "row") return true;
      if (html.hasAttribute("onclick")) return true;
      if (html.tabIndex >= 0) return true;
      return window.getComputedStyle(html).cursor === "pointer";
    };

    const controls = [
      "button",
      "a[href]",
      "input",
      "textarea",
      "select",
      "summary",
      "[contenteditable=true]",
      "[role]",
      "[onclick]",
      "[tabindex]",
    ].join(",");

    const candidateNodes = Array.from(document.querySelectorAll<Element>(controls));
    const boundedCandidates = candidateNodes.slice(0, input.maxCandidateNodes);
    const candidateSet = new Set<Element>();
    const elementDrafts: Array<{ element: Element; raw: BrowserRawElement }> = [];

    for (const element of boundedCandidates) {
      const html = element as HTMLElement;
      const accessibility = computedAccessibility(element);
      const nativeRole = nativeRoleFor(element);
      const role = normalizeRole(
        accessibility.role || html.getAttribute("role") || undefined,
        nativeRole,
      );
      if (!isPotentiallyInteractive(element, role)) continue;
      if (!isRendered(element)) continue;

      const inViewport = isInViewport(element);
      if (inViewport && isObscuredAtCenter(element)) continue;

      const selector = selectorFor(element);
      const inputElement = element instanceof HTMLInputElement ? element : undefined;
      const optionElement = element instanceof HTMLOptionElement ? element : undefined;
      const raw: BrowserRawElement = {
        selector,
        fallbackSelector: fallbackSelectorFor(element),
        tagName: element.tagName.toLowerCase(),
        role,
        name: accessibleNameFor(element, accessibility.name),
        text: normalizeText(html.innerText || html.textContent, 240) || undefined,
        placeholder: html.getAttribute("placeholder") ?? undefined,
        value: valueFor(element),
        inputType: inputElement?.type.toLowerCase(),
        visible: true,
        inViewport,
        enabled: isEnabled(element),
        checked:
          inputElement?.type === "checkbox" || inputElement?.type === "radio"
            ? inputElement.checked
            : html.getAttribute("aria-checked") === "true"
              ? true
              : html.getAttribute("aria-checked") === "false"
                ? false
                : undefined,
        selected:
          optionElement?.selected ??
          (html.getAttribute("aria-selected") === "true"
            ? true
            : html.getAttribute("aria-selected") === "false"
              ? false
              : undefined),
        expanded:
          html.getAttribute("aria-expanded") === "true"
            ? true
            : html.getAttribute("aria-expanded") === "false"
              ? false
              : undefined,
        required:
          inputElement?.required ||
          (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
            ? element.required
            : html.getAttribute("aria-required") === "true"
              ? true
              : undefined),
        readOnly:
          inputElement?.readOnly ||
          (element instanceof HTMLTextAreaElement
            ? element.readOnly
            : html.getAttribute("aria-readonly") === "true"
              ? true
              : undefined),
        bounds: boundsFor(element),
      };
      candidateSet.add(element);
      elementDrafts.push({ element, raw });
      if (elementDrafts.length >= input.maxInteractables) break;
    }

    for (const draft of elementDrafts) {
      let parent = draft.element.parentElement;
      while (parent) {
        if (candidateSet.has(parent)) {
          draft.raw.parentSelector = selectorFor(parent);
          break;
        }
        parent = parent.parentElement;
      }
      const form = draft.element.closest("form");
      const table = draft.element.closest("table, [role=table], [role=grid]");
      const row = draft.element.closest("tr, [role=row]");
      if (form) draft.raw.formSelector = selectorFor(form);
      if (table) draft.raw.tableSelector = selectorFor(table);
      if (row) draft.raw.rowSelector = selectorFor(row);
    }

    const elements = elementDrafts.map((draft) => draft.raw);

    const forms: BrowserRawForm[] = [];
    let formNumber = 0;
    for (const form of Array.from(document.querySelectorAll("form, [role=form]"))) {
      if (!isRendered(form)) continue;
      formNumber += 1;
      const selector = selectorFor(form);
      const heading = form.querySelector("legend, h1, h2, h3, h4, h5, h6");
      forms.push({
        id: `form-${formNumber}`,
        selector,
        name:
          accessibleNameFor(form, computedAccessibility(form).name) ||
          normalizeText(heading?.textContent) ||
          undefined,
        visible: true,
        bounds: boundsFor(form),
        controlSelectors: elements
          .filter((element) => element.formSelector === selector)
          .map((element) => element.selector),
      });
    }

    const tableNodes = Array.from(document.querySelectorAll("table, [role=table], [role=grid]"));
    const tables: BrowserRawTable[] = [];
    for (const [tableIndex, table] of tableNodes.entries()) {
      if (!isRendered(table)) continue;
      const selector = selectorFor(table);
      const headerNodes = Array.from(
        table.querySelectorAll("thead th, [role=columnheader]"),
      );
      const columns = headerNodes
        .map((header) => normalizeText(header.textContent, 120))
        .filter(Boolean);
      const rowNodes = Array.from(
        table.querySelectorAll(":scope > tbody > tr, :scope > tr, [role=row]"),
      ).filter((row) => isRendered(row));
      const rows: BrowserRawTableRow[] = [];
      for (const row of rowNodes.slice(0, input.maxTableRows)) {
        const rowSelector = selectorFor(row);
        const cellNodes = Array.from(row.querySelectorAll("th, td, [role=gridcell], [role=cell]"));
        const cells: Record<string, string> = {};
        cellNodes.forEach((cell, index) => {
          const key = columns[index] || `Column ${index + 1}`;
          cells[key] = normalizeText(cell.textContent, 240);
        });
        rows.push({
          selector: rowSelector,
          tagName: row.tagName.toLowerCase(),
          text: normalizeText((row as HTMLElement).innerText || row.textContent, 320) || undefined,
          visible: true,
          bounds: boundsFor(row),
          cells,
          actionSelectors: elements
            .filter((element) => element.rowSelector === rowSelector)
            .map((element) => element.selector),
        });
      }
      const caption = table.querySelector("caption");
      tables.push({
        id: `table-${tableIndex + 1}`,
        selector,
        name:
          accessibleNameFor(table, computedAccessibility(table).name) ||
          normalizeText(caption?.textContent) ||
          undefined,
        visible: true,
        bounds: boundsFor(table),
        columns,
        rows,
        truncated: rowNodes.length > rows.length || undefined,
      });
    }

    const containers: BrowserRawContainer[] = [];
    const seenContainerSelectors = new Set<string>();
    const addContainer = (element: Element, role: BrowserContainerRole): void => {
      if (!isRendered(element)) return;
      const selector = selectorFor(element);
      if (seenContainerSelectors.has(selector)) return;
      seenContainerSelectors.add(selector);
      const html = element as HTMLElement;
      const classNames = html.className.toString().toLowerCase();
      const resolvedRole: BrowserContainerRole =
        role === "dialog" && (html.hasAttribute("data-drawer") || classNames.includes("drawer"))
          ? "drawer"
          : role;
      containers.push({
        id: `container-${containers.length + 1}`,
        selector,
        role: resolvedRole,
        name: accessibleNameFor(element, computedAccessibility(element).name),
        text: normalizeText(html.innerText || html.textContent, 320) || undefined,
        visible: true,
        bounds: boundsFor(element),
        active: role === "dialog" || role === "alertdialog" || role === "menu",
      });
    };

    for (const dialog of Array.from(
      document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=\"true\"]"),
    )) {
      const role = dialog.getAttribute("role") === "alertdialog" ? "alertdialog" : "dialog";
      addContainer(dialog, role);
    }
    for (const menu of Array.from(document.querySelectorAll("[role=menu], [role=listbox]"))) {
      addContainer(menu, "menu");
    }
    for (const popover of Array.from(document.querySelectorAll("[popover]:not([hidden])"))) {
      addContainer(popover, "popover");
    }
    for (const tooltip of Array.from(document.querySelectorAll("[role=tooltip]"))) {
      addContainer(tooltip, "tooltip");
    }

    const dialogs = containers.filter(
      (container) => container.role === "dialog" || container.role === "alertdialog" || container.role === "drawer",
    );
    const menus = containers.filter(
      (container) =>
        container.role === "menu" || container.role === "popover" || container.role === "tooltip",
    );

    const notifications: BrowserNotification[] = [];
    const seenNotifications = new Set<Element>();
    for (const node of Array.from(
      document.querySelectorAll("[role=alert], [role=status], [role=log], [aria-live]:not([aria-live=off])"),
    )) {
      if (seenNotifications.has(node) || !isRendered(node)) continue;
      seenNotifications.add(node);
      const roleAttribute = node.getAttribute("role")?.toLowerCase();
      const role =
        roleAttribute === "alert" || roleAttribute === "status" || roleAttribute === "log"
          ? roleAttribute
          : "other";
      const text = normalizeText((node as HTMLElement).innerText || node.textContent, 320);
      if (!text) continue;
      notifications.push({
        id: `notification-${notifications.length + 1}`,
        role,
        text,
        visible: true,
      });
    }

    const meaningfulStructure = [
      ...elements.slice(0, 100).map((element) => `${element.role}:${element.name ?? element.text ?? ""}`),
      ...forms.map((form) => `form:${form.name ?? ""}:${form.controlSelectors.length}`),
      ...tables.map((table) => `table:${table.name ?? ""}:${table.columns.join("|")}:${table.rows.length}`),
    ].join("\u001e");
    const dialogFingerprint = dialogs
      .map((dialog) => `${dialog.role}:${dialog.name ?? dialog.text ?? ""}`)
      .join("\u001e");
    const menuFingerprint = menus
      .map((menu) => `${menu.role}:${menu.name ?? menu.text ?? ""}`)
      .join("\u001e");
    const notificationFingerprint = notifications
      .map((notification) => `${notification.role}:${notification.text}`)
      .join("\u001e");

    return {
      page: {
        url: window.location.href,
        title: document.title,
        text: normalizeText(document.body?.innerText || document.body?.textContent, input.maxTextLength) || undefined,
      },
      elements,
      forms,
      tables,
      dialogs,
      menus,
      notifications,
      stateInput: {
        dialogFingerprint,
        menuFingerprint,
        notificationFingerprint,
        structureFingerprint: meaningfulStructure,
      },
    };
  }, normalizedOptions);
}
