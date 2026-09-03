import { asBrowserMcpError } from "./errors.js";

export type ToolPayload = object;

/**
 * Keep a compact text representation for clients that only render text, while
 * exposing the original object through structuredContent for capable clients.
 */
export function success<T extends ToolPayload>(payload: T, summary?: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: summary ?? JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload as Record<string, unknown>,
  };
}

export function failure(error: unknown) {
  const normalized = asBrowserMcpError(error);
  const payload = {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}
