import type { ElementHandle } from "puppeteer-core";

/**
 * A short, opaque identifier assigned to an element during an observation.
 * Consumers must treat these values as opaque; they are intentionally not CSS
 * selectors or CDP node ids.
 */
export type ElementRef = string;

export type SemanticRole =
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

export type ContainerRole =
  | "dialog"
  | "alertdialog"
  | "menu"
  | "drawer"
  | "popover"
  | "tooltip";

export interface Bounds {
  /** Coordinates are relative to the current viewport. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A private, re-identifiable location for an observed node. It is deliberately
 * not included in the serializable element model exposed through MCP.
 */
export interface ElementLocator {
  strategy: "css" | "xpath";
  value: string;
  /** A less-specific locator used only when the primary path no longer works. */
  fallback?: string;
  fingerprint: ElementFingerprint;
}

/** Values used to ensure a locator still points at the observed element. */
export interface ElementFingerprint {
  tagName: string;
  role: SemanticRole;
  name?: string;
  inputType?: string;
  placeholder?: string;
}

export interface Interactable {
  ref: ElementRef;
  role: SemanticRole;
  name?: string;
  text?: string;
  placeholder?: string;
  value?: string;
  inputType?: string;
  visible: boolean;
  /** Whether the element currently intersects the viewport. */
  inViewport: boolean;
  enabled: boolean;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  required?: boolean;
  readOnly?: boolean;
  bounds?: Bounds;
  parentRef?: ElementRef;
  formId?: string;
  tableId?: string;
  rowRef?: ElementRef;
}

export interface SemanticForm {
  id: string;
  name?: string;
  visible: boolean;
  bounds?: Bounds;
  controls: ElementRef[];
}

export interface SemanticTableRow {
  ref: ElementRef;
  text?: string;
  cells: Record<string, string>;
  actions: ElementRef[];
}

export interface SemanticTable {
  id: string;
  name?: string;
  visible: boolean;
  bounds?: Bounds;
  columns: string[];
  rows: SemanticTableRow[];
  truncated?: boolean;
}

export interface SemanticContainer {
  id: string;
  role: ContainerRole;
  name?: string;
  text?: string;
  visible: boolean;
  bounds?: Bounds;
  active?: boolean;
}

export interface Notification {
  id: string;
  role: "alert" | "status" | "log" | "other";
  text: string;
  visible: boolean;
}

export interface PageSummary {
  url: string;
  title: string;
  /** Visible, normalized text. It is capped by Observer options. */
  text?: string;
}

export type StateChangeReason =
  | "initial_observation"
  | "url_changed"
  | "title_changed"
  | "dialog_changed"
  | "menu_changed"
  | "notification_changed"
  | "structure_changed";

export interface PageState {
  id: string;
  url: string;
  title: string;
  fingerprint: string;
  observedAt: string;
}

export interface StateTransition {
  previous?: PageState;
  current: PageState;
  changed: boolean;
  reasons: StateChangeReason[];
}

/**
 * The runtime record retained by ElementRegistry. The selector and backend id
 * are internal implementation details and must not be required from MCP users.
 */
export interface RegisteredElement {
  ref: ElementRef;
  epoch: number;
  observedAt: number;
  /** Direct copies make action handlers fast and avoid re-reading semantic data. */
  role: SemanticRole;
  name?: string;
  visible: boolean;
  enabled: boolean;
  /** CDP backend node identity, when Puppeteer/Chrome made it available. */
  backendNodeId?: number;
  /** Current CSS re-identification selector; private to the server. */
  selector: string;
  locator: ElementLocator;
  semantic: Interactable;
  /** Present only while an interaction handler elects to retain a handle. */
  handle?: ElementHandle<Element>;
}

export interface Observation {
  epoch: number;
  page: PageSummary;
  state: PageState;
  transition: StateTransition;
  interactables: Interactable[];
  forms: SemanticForm[];
  tables: SemanticTable[];
  dialogs: SemanticContainer[];
  menus: SemanticContainer[];
  notifications: Notification[];
  /**
   * Runtime-only metadata keyed by ref. Maps are not JSON serialized, which
   * keeps selectors and CDP identities out of regular MCP responses.
   */
  elements: ReadonlyMap<ElementRef, RegisteredElement>;
}

export type SerializableObservation = Omit<Observation, "elements">;

/** Return the safe JSON-facing part of an observation. */
export function toSerializableObservation(
  observation: Observation,
): SerializableObservation {
  return {
    epoch: observation.epoch,
    page: observation.page,
    state: observation.state,
    transition: observation.transition,
    interactables: observation.interactables,
    forms: observation.forms,
    tables: observation.tables,
    dialogs: observation.dialogs,
    menus: observation.menus,
    notifications: observation.notifications,
  };
}
