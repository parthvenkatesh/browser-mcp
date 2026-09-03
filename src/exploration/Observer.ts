import type { ElementHandle, Page } from "puppeteer-core";

import {
  analyzePage,
  type DomAnalyzerOptions,
  type RawPageAnalysis,
  type RawSemanticElement,
  type RawTableRow,
} from "./DomAnalyzer.js";
import { ElementRegistry } from "./ElementRegistry.js";
import type {
  ElementLocator,
  Interactable,
  Observation,
  RegisteredElement,
  SemanticForm,
  SemanticTable,
  SemanticTableRow,
} from "./SemanticModel.js";
import { StateTracker } from "./StateTracker.js";

export interface ObserverOptions extends DomAnalyzerOptions {
  registry?: ElementRegistry;
  stateTracker?: StateTracker;
  /** Disable only when latency matters more than CDP node diagnostics. */
  captureBackendNodeIds?: boolean;
  maxBackendNodeIds?: number;
}

/**
 * Builds a compact semantic representation of a Chromium page. It does not
 * expose selectors in its JSON-facing observation, but saves re-identification
 * data in ElementRegistry for interaction services.
 */
export class Observer {
  readonly registry: ElementRegistry;
  readonly stateTracker: StateTracker;
  private readonly options: Required<
    Pick<ObserverOptions, "captureBackendNodeIds" | "maxBackendNodeIds">
  > &
    DomAnalyzerOptions;

  constructor(options: ObserverOptions = {}) {
    this.registry = options.registry ?? new ElementRegistry();
    this.stateTracker = options.stateTracker ?? new StateTracker();
    this.options = {
      maxInteractables: options.maxInteractables,
      maxTableRows: options.maxTableRows,
      maxTextLength: options.maxTextLength,
      maxCandidateNodes: options.maxCandidateNodes,
      captureBackendNodeIds: options.captureBackendNodeIds ?? true,
      maxBackendNodeIds: options.maxBackendNodeIds ?? 250,
    };
  }

  async observe(page: Page): Promise<Observation> {
    const analysis = await analyzePage(page, this.options);
    const transition = this.stateTracker.track({
      url: analysis.page.url,
      title: analysis.page.title,
      ...analysis.stateInput,
    });
    const epoch = this.registry.beginObservation({ stateId: transition.current.id });

    const backendNodeIds = this.options.captureBackendNodeIds
      ? await lookupBackendNodeIds(
          page,
          selectorsForAnalysis(analysis),
          this.options.maxBackendNodeIds,
        )
      : new Map<string, number>();

    const tableIdBySelector = new Map(
      analysis.tables.map((table) => [table.selector, table.id]),
    );
    const formIdBySelector = new Map(
      analysis.forms.map((form) => [form.selector, form.id]),
    );
    const rowEntryBySelector = new Map<string, RegisteredElement>();

    // Rows get their own compact `r*` refs, which makes large tables readable
    // while still letting an interaction service resolve a clickable row.
    for (const table of analysis.tables) {
      for (const row of table.rows) {
        rowEntryBySelector.set(
          row.selector,
          this.registry.register({
            prefix: "r",
            backendNodeId: backendNodeIds.get(row.selector),
            locator: locatorForRow(row),
            semantic: {
              role: "row",
              name: row.text,
              text: row.text,
              visible: row.visible,
              inViewport: isInViewport(row.bounds),
              enabled: true,
              bounds: row.bounds,
              tableId: table.id,
            },
          }),
        );
      }
    }

    const elementEntryBySelector = new Map<string, RegisteredElement>();
    for (const raw of analysis.elements) {
      const entry = this.registry.register({
        prefix: "e",
        backendNodeId: backendNodeIds.get(raw.selector),
        locator: locatorForElement(raw),
        semantic: semanticForElement(raw, {
          formId: raw.formSelector
            ? formIdBySelector.get(raw.formSelector)
            : undefined,
          tableId: raw.tableSelector
            ? tableIdBySelector.get(raw.tableSelector)
            : undefined,
          rowRef: raw.rowSelector
            ? rowEntryBySelector.get(raw.rowSelector)?.ref
            : undefined,
        }),
      });
      elementEntryBySelector.set(raw.selector, entry);
    }

    // Relationships can point forward in DOM order, so attach them after all
    // refs have been allocated. The objects are runtime-only registry records.
    for (const raw of analysis.elements) {
      const entry = elementEntryBySelector.get(raw.selector);
      if (!entry) continue;
      const parentRef = raw.parentSelector
        ? elementEntryBySelector.get(raw.parentSelector)?.ref
        : undefined;
      if (parentRef) entry.semantic.parentRef = parentRef;
    }

    const forms: SemanticForm[] = analysis.forms.map((form) => ({
      id: form.id,
      name: form.name,
      visible: form.visible,
      bounds: form.bounds,
      controls: form.controlSelectors.flatMap((selector) => {
        const ref = elementEntryBySelector.get(selector)?.ref;
        return ref ? [ref] : [];
      }),
    }));

    const tables: SemanticTable[] = analysis.tables.map((table) => ({
      id: table.id,
      name: table.name,
      visible: table.visible,
      bounds: table.bounds,
      columns: table.columns,
      rows: table.rows.flatMap((row) => {
        const ref = rowEntryBySelector.get(row.selector)?.ref;
        if (!ref) return [];
        return [semanticRow(row, ref, elementEntryBySelector)];
      }),
      truncated: table.truncated,
    }));

    return {
      epoch,
      page: analysis.page,
      state: transition.current,
      transition,
      interactables: Array.from(elementEntryBySelector.values()).map(
        (entry) => entry.semantic,
      ),
      forms,
      tables,
      dialogs: analysis.dialogs,
      menus: analysis.menus,
      notifications: analysis.notifications,
      elements: this.registry.entries(),
    };
  }

  /** Explicitly expire refs after an action whose DOM outcome is uncertain. */
  invalidate(
    reason = "The page or application state changed after the previous observation.",
  ): void {
    this.registry.invalidate(reason);
  }
}

function semanticForElement(
  raw: RawSemanticElement,
  relationships: Pick<Interactable, "formId" | "tableId" | "rowRef">,
): Omit<Interactable, "ref"> {
  return {
    role: raw.role,
    name: raw.name,
    text: raw.text,
    placeholder: raw.placeholder,
    value: raw.value,
    inputType: raw.inputType,
    visible: raw.visible,
    inViewport: raw.inViewport,
    enabled: raw.enabled,
    checked: raw.checked,
    selected: raw.selected,
    expanded: raw.expanded,
    required: raw.required,
    readOnly: raw.readOnly,
    bounds: raw.bounds,
    ...relationships,
  };
}

function semanticRow(
  row: RawTableRow,
  ref: string,
  elements: ReadonlyMap<string, RegisteredElement>,
): SemanticTableRow {
  return {
    ref,
    text: row.text,
    cells: row.cells,
    actions: row.actionSelectors.flatMap((selector) => {
      const actionRef = elements.get(selector)?.ref;
      return actionRef ? [actionRef] : [];
    }),
  };
}

function locatorForElement(raw: RawSemanticElement): ElementLocator {
  return {
    strategy: "css",
    value: raw.selector,
    fallback:
      raw.fallbackSelector && raw.fallbackSelector !== raw.selector
        ? raw.fallbackSelector
        : undefined,
    fingerprint: {
      tagName: raw.tagName,
      role: raw.role,
      name: raw.name,
      inputType: raw.inputType,
      placeholder: raw.placeholder,
    },
  };
}

function locatorForRow(row: RawTableRow): ElementLocator {
  return {
    strategy: "css",
    value: row.selector,
    fingerprint: {
      tagName: row.tagName,
      role: "row",
      name: row.text,
    },
  };
}

function isInViewport(bounds: { x: number; y: number; width: number; height: number } | undefined): boolean {
  // A row is useful even below the fold because interaction code scrolls it
  // into view. Bounds cannot establish the viewport size here, so a present
  // bounding box is the least surprising semantic answer.
  return Boolean(bounds);
}

function selectorsForAnalysis(analysis: RawPageAnalysis): string[] {
  const selectors = new Set<string>();
  for (const element of analysis.elements) selectors.add(element.selector);
  for (const table of analysis.tables) {
    for (const row of table.rows) selectors.add(row.selector);
  }
  return Array.from(selectors);
}

async function lookupBackendNodeIds(
  page: Page,
  selectors: string[],
  maxSelectors: number,
): Promise<Map<string, number>> {
  const output = new Map<string, number>();
  const selected = selectors.slice(0, Math.max(0, maxSelectors));
  const concurrency = 12;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= selected.length) return;
      const selector = selected[index];
      if (!selector) continue;
      const backendNodeId = await backendNodeIdFor(page, selector);
      if (backendNodeId !== undefined) output.set(selector, backendNodeId);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()),
  );
  return output;
}

async function backendNodeIdFor(
  page: Page,
  selector: string,
): Promise<number | undefined> {
  let handle: ElementHandle<Element> | null = null;
  try {
    handle = await page.$(selector);
    if (!handle) return undefined;
    const candidate = handle as unknown as {
      backendNodeId?: () => Promise<number>;
    };
    return typeof candidate.backendNodeId === "function"
      ? await candidate.backendNodeId()
      : undefined;
  } catch {
    // A dynamic page may mutate between DOM collection and lookup. Ref
    // resolution still validates its selector/fingerprint before an action.
    return undefined;
  } finally {
    if (handle) {
      try {
        await handle.dispose();
      } catch {
        // Detached handles do not need explicit cleanup.
      }
    }
  }
}
