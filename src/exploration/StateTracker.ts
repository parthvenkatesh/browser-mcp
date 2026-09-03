import type {
  PageState,
  StateChangeReason,
  StateTransition,
} from "./SemanticModel.js";

/** Inputs deliberately focus on semantic signals, not arbitrary DOM mutations. */
export interface StateInput {
  url: string;
  title: string;
  dialogFingerprint?: string;
  menuFingerprint?: string;
  notificationFingerprint?: string;
  structureFingerprint?: string;
}

/**
 * Tracks the application state at a coarse semantic level. It is intentionally
 * conservative: text-counter or animation mutations do not cause a new state
 * unless they change the observer's meaningful structure fingerprint.
 */
export class StateTracker {
  private currentState: PageState | undefined;
  private previousInput: StateInput | undefined;
  private nextStateNumber = 0;

  get current(): PageState | undefined {
    return this.currentState;
  }

  reset(): void {
    this.currentState = undefined;
    this.previousInput = undefined;
    this.nextStateNumber = 0;
  }

  track(input: StateInput): StateTransition {
    const fingerprint = fingerprintForState(input);
    const previous = this.currentState;

    if (!previous) {
      const current = this.createState(input, fingerprint);
      this.currentState = current;
      this.previousInput = { ...input };
      return {
        current,
        changed: true,
        reasons: ["initial_observation"],
      };
    }

    const reasons = determineReasons(this.previousInput, previous, input, fingerprint);
    if (reasons.length === 0) {
      const current: PageState = {
        ...previous,
        observedAt: new Date().toISOString(),
      };
      this.currentState = current;
      this.previousInput = { ...input };
      return { previous, current, changed: false, reasons };
    }

    const current = this.createState(input, fingerprint);
    this.currentState = current;
    this.previousInput = { ...input };
    return { previous, current, changed: true, reasons };
  }

  /** Alias used by callers that prefer an event-like API. */
  update(input: StateInput): StateTransition {
    return this.track(input);
  }

  private createState(input: StateInput, fingerprint: string): PageState {
    this.nextStateNumber += 1;
    return {
      id: `state-${this.nextStateNumber}`,
      url: input.url,
      title: input.title,
      fingerprint,
      observedAt: new Date().toISOString(),
    };
  }
}

export function fingerprintForState(input: StateInput): string {
  const normalized = [
    normalize(input.url),
    normalize(input.title),
    normalize(input.dialogFingerprint),
    normalize(input.menuFingerprint),
    normalize(input.notificationFingerprint),
    normalize(input.structureFingerprint),
  ].join("\u001f");

  return `s${fnv1a(normalized).toString(36)}`;
}

function determineReasons(
  previousInput: StateInput | undefined,
  previous: PageState,
  input: StateInput,
  fingerprint: string,
): StateChangeReason[] {
  if (previous.fingerprint === fingerprint) {
    return [];
  }

  const reasons: StateChangeReason[] = [];
  if (normalize(previous.url) !== normalize(input.url)) {
    reasons.push("url_changed");
  }
  if (normalize(previous.title) !== normalize(input.title)) {
    reasons.push("title_changed");
  }

  if (
    previousInput &&
    normalize(previousInput.dialogFingerprint) !== normalize(input.dialogFingerprint)
  ) {
    reasons.push("dialog_changed");
  }
  if (
    previousInput &&
    normalize(previousInput.menuFingerprint) !== normalize(input.menuFingerprint)
  ) {
    reasons.push("menu_changed");
  }
  if (
    previousInput &&
    normalize(previousInput.notificationFingerprint) !==
      normalize(input.notificationFingerprint)
  ) {
    reasons.push("notification_changed");
  }
  if (
    previousInput &&
    normalize(previousInput.structureFingerprint) !==
      normalize(input.structureFingerprint)
  ) {
    reasons.push("structure_changed");
  }

  // A fingerprint mismatch can only occur due to a component difference. The
  // fallback keeps the method robust should an older StateTracker be restored
  // without its internal input history.
  if (reasons.length === 0) reasons.push("structure_changed");

  return reasons;
}

function normalize(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // `Math.imul` preserves the intended 32-bit overflow on every JS runtime.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
