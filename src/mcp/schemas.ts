import { z } from "zod";

export const browserNameSchema = z.enum(["chrome", "chromium", "edge"]);

export const locatorSchema = z.object({
  strategy: z.enum(["css", "xpath"]),
  value: z.string().min(1).max(4_000),
});

export const startInputSchema = z.object({
  browser: browserNameSchema.optional().describe("Browser to launch. Overrides BROWSER for this call."),
  useUserProfile: z.boolean().optional().describe("Reuse the installed browser profile. Defaults to true; set false for an isolated profile."),
});

export const closeInputSchema = z.object({
  forceExternal: z.boolean().optional().describe(
    "Also close an externally managed CDP browser. Defaults to false and should be used only with explicit user authorization.",
  ),
});

export const navigateInputSchema = z.object({
  url: z.string().url().describe("Absolute http(s) URL to load in the active tab."),
  timeout: z.number().int().positive().max(120_000).optional(),
});

export const refInputSchema = z.object({
  ref: z.string().min(1).max(64).optional().describe("Element reference returned by browser_observe."),
  locator: locatorSchema.optional().describe("A locator that must resolve to exactly one element."),
}).refine((value) => Boolean(value.ref || value.locator), {
  message: "Provide either ref or locator.",
});

export const fillInputSchema = refInputSchema.extend({
  value: z.string().describe("Replacement value for the input."),
});

export const typeInputSchema = refInputSchema.extend({
  text: z.string().describe("Text to type using keyboard events."),
});

export const pressInputSchema = refInputSchema.extend({
  key: z.enum([
    "Enter",
    "Tab",
    "Escape",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Backspace",
    "Delete",
    "Space",
  ]),
});

export const selectInputSchema = refInputSchema.extend({
  value: z.string().min(1).describe("Native option value or visible option text."),
});

export const waitInputSchema = z.object({
  condition: z.enum([
    "network_idle",
    "navigation",
    "element_visible",
    "element_enabled",
    "text_visible",
    "text_hidden",
  ]),
  ref: z.string().min(1).max(64).optional(),
  locator: locatorSchema.optional(),
  text: z.string().min(1).max(4_000).optional(),
  timeout: z.number().int().positive().max(120_000).optional(),
}).superRefine((value, context) => {
  if (["element_visible", "element_enabled"].includes(value.condition) && !value.ref && !value.locator) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "ref or locator is required for this condition", path: ["ref"] });
  }
  if (["text_visible", "text_hidden"].includes(value.condition) && !value.text) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "text is required for this condition", path: ["text"] });
  }
});

export const waitForElementInputSchema = z.object({
  role: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(1_000).optional(),
  timeout: z.number().int().positive().max(120_000).optional(),
}).refine((value) => Boolean(value.role || value.name), {
  message: "At least one of role or name is required.",
});

export const screenshotInputSchema = z.object({
  fullPage: z.boolean().optional().default(false),
});

export const newTabInputSchema = z.object({
  url: z.string().url().optional(),
});

export const switchTabInputSchema = z.object({
  tabId: z.string().min(1).max(128),
});

export const closeTabInputSchema = z.object({
  tabId: z.string().min(1).max(128),
});

export const switchFrameInputSchema = z.object({
  frameId: z.string().min(1).max(128),
});

export const evaluateInputSchema = z.object({
  expression: z.string().min(1).max(20_000),
});

export type StartInput = z.infer<typeof startInputSchema>;
export type NavigateInput = z.infer<typeof navigateInputSchema>;
export type RefInput = z.infer<typeof refInputSchema>;
export type FillInput = z.infer<typeof fillInputSchema>;
export type TypeInput = z.infer<typeof typeInputSchema>;
export type PressInput = z.infer<typeof pressInputSchema>;
export type SelectInput = z.infer<typeof selectInputSchema>;
export type WaitInput = z.infer<typeof waitInputSchema>;
export type WaitForElementInput = z.infer<typeof waitForElementInputSchema>;
export type ScreenshotInput = z.infer<typeof screenshotInputSchema>;
export type NewTabInput = z.infer<typeof newTabInputSchema>;
export type SwitchTabInput = z.infer<typeof switchTabInputSchema>;
export type CloseTabInput = z.infer<typeof closeTabInputSchema>;
export type SwitchFrameInput = z.infer<typeof switchFrameInputSchema>;
export type EvaluateInput = z.infer<typeof evaluateInputSchema>;
