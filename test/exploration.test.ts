import { describe, expect, it } from "vitest";

import {
  ElementRegistry,
  StaleElementReferenceError,
  UnknownElementReferenceError,
} from "../src/exploration/ElementRegistry.js";
import { StateTracker } from "../src/exploration/StateTracker.js";

function registerButton(registry: ElementRegistry, name: string) {
  return registry.register({
    semantic: {
      role: "button",
      name,
      visible: true,
      inViewport: true,
      enabled: true,
    },
    locator: {
      strategy: "css",
      value: `button[aria-label="${name}"]`,
      fingerprint: { tagName: "button", role: "button", name },
    },
  });
}

describe("ElementRegistry", () => {
  it("issues opaque, resolvable refs with action metadata", () => {
    const registry = new ElementRegistry();
    registry.beginObservation({ stateId: "state-1" });
    const entry = registerButton(registry, "Save");

    expect(entry.ref).toBe("e1");
    expect(registry.resolve(entry.ref)).toMatchObject({
      ref: "e1",
      role: "button",
      name: "Save",
      visible: true,
      enabled: true,
      selector: 'button[aria-label="Save"]',
    });
  });

  it("never recycles refs and reports an old observation as stale", () => {
    const registry = new ElementRegistry();
    registry.beginObservation();
    const first = registerButton(registry, "Save");
    registry.beginObservation();
    const second = registerButton(registry, "Cancel");

    expect(second.ref).toBe("e2");
    expect(() => registry.resolve(first.ref)).toThrow(StaleElementReferenceError);
    expect(() => registry.resolve("e999")).toThrow(UnknownElementReferenceError);
  });

  it("retains an explicit invalidation reason", () => {
    const registry = new ElementRegistry();
    registry.beginObservation();
    const entry = registerButton(registry, "Save");
    registry.invalidate("Navigation completed.");

    expect(() => registry.resolve(entry.ref)).toThrow("Navigation completed.");
  });
});

describe("StateTracker", () => {
  it("keeps a state id for semantically equivalent observations", () => {
    const tracker = new StateTracker();
    const initial = tracker.track({
      url: "https://example.test/customers",
      title: "Customers",
      structureFingerprint: "button:Create customer",
    });
    const repeated = tracker.track({
      url: "https://example.test/customers",
      title: "Customers",
      structureFingerprint: "button:Create customer",
    });

    expect(initial.current.id).toBe("state-1");
    expect(repeated.changed).toBe(false);
    expect(repeated.current.id).toBe("state-1");
  });

  it("explains route and dialog state transitions", () => {
    const tracker = new StateTracker();
    tracker.track({
      url: "https://example.test/customers",
      title: "Customers",
      structureFingerprint: "button:Create customer",
    });
    const transition = tracker.track({
      url: "https://example.test/customers/new",
      title: "Create customer",
      dialogFingerprint: "dialog:Create customer",
      structureFingerprint: "textbox:Company|button:Save",
    });

    expect(transition.changed).toBe(true);
    expect(transition.current.id).toBe("state-2");
    expect(transition.reasons).toEqual(
      expect.arrayContaining(["url_changed", "title_changed", "dialog_changed", "structure_changed"]),
    );
  });
});

