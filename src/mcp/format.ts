import type {
  Interactable,
  Observation,
  SemanticContainer,
  SemanticForm,
  SemanticTable,
} from "../exploration/SemanticModel.js";

/** A bounded, human/agent-friendly complement to structured observation JSON. */
export function renderObservation(observation: Observation): string {
  const lines: string[] = [];
  const { page } = observation;

  lines.push(`Page: ${page.title || "Untitled"}`);
  lines.push(`URL: ${page.url}`);
  lines.push(`State: ${observation.state.id}`);

  if (observation.transition.changed) {
    lines.push(`State change: ${observation.transition.reasons.join(", ")}`);
  }

  addSection(lines, "INTERACTABLES", observation.interactables.map(renderInteractable));
  addSection(lines, "FORMS", observation.forms.map(renderForm));
  addSection(lines, "TABLES", observation.tables.map(renderTable));
  addSection(lines, "DIALOGS", observation.dialogs.map(renderContainer));
  addSection(lines, "MENUS", observation.menus.map(renderContainer));

  addSection(
    lines,
    "NOTIFICATIONS",
    observation.notifications.length
      ? observation.notifications.map((notification) => `${notification.role}: ${notification.text}`)
      : ["None"],
  );

  return lines.join("\n");
}

export function renderInteractable(element: Interactable): string {
  const ref = `[${element.ref}]`;
  const label = element.name ?? element.placeholder ?? element.text ?? "unnamed";
  const state = [
    !element.enabled ? "disabled" : undefined,
    element.checked === true ? "checked" : undefined,
    element.checked === false && ["checkbox", "radio", "switch"].includes(element.role)
      ? "unchecked"
      : undefined,
    element.value ? `value=${quote(element.value)}` : undefined,
  ].filter(Boolean);
  return `${ref} ${element.role} ${quote(label)}${state.length ? ` (${state.join(", ")})` : ""}`;
}

function renderForm(form: SemanticForm): string {
  return `${form.name ?? "Unnamed form"} (${form.controls.length} controls: ${form.controls.join(", ") || "none"})`;
}

function renderTable(table: SemanticTable): string {
  const heading = `${table.name ?? "Unnamed table"}: ${table.columns.join(" | ") || "no headers"}`;
  const rows = table.rows.slice(0, 10).map((row) => {
    const cells = Object.entries(row.cells)
      .map(([column, value]) => `${column}: ${value}`)
      .join("; ");
    const actions = row.actions.length ? ` [${row.actions.join(", ")}]` : "";
    return `  [${row.ref}] ${cells || row.text || "empty"}${actions}`;
  });
  const suffix = table.truncated || table.rows.length > 10 ? "\n  …additional rows omitted" : "";
  return [heading, ...rows].join("\n") + suffix;
}

function renderContainer(container: SemanticContainer): string {
  const label = container.name ?? container.text ?? "Unnamed";
  return `${container.role} ${quote(label)}`;
}

function addSection(lines: string[], heading: string, entries: string[]): void {
  lines.push("", heading);
  if (entries.length === 0) {
    lines.push("None");
    return;
  }
  lines.push(...entries);
}

function quote(value: string): string {
  return `"${value.replace(/\s+/g, " ").trim().slice(0, 240)}"`;
}
