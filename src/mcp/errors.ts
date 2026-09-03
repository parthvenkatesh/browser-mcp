/**
 * Errors deliberately carry an actionable, agent-facing message.  Tool handlers
 * convert these errors into MCP responses instead of leaking implementation
 * stack traces to the client.
 */
export class BrowserMcpError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  public constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BrowserMcpError";
    this.code = code;
    this.details = details;
  }
}

export function asBrowserMcpError(error: unknown): BrowserMcpError {
  if (error instanceof BrowserMcpError) {
    return error;
  }

  if (error instanceof Error) {
    const record = error as Error & {
      code?: unknown;
      details?: unknown;
      diagnostics?: unknown;
    };
    const code = typeof record.code === "string" ? record.code : "INTERNAL_ERROR";
    const rawDetails = record.details ?? record.diagnostics;
    const details = isRecord(rawDetails) ? rawDetails : undefined;
    return new BrowserMcpError(code, error.message, details);
  }

  return new BrowserMcpError("INTERNAL_ERROR", "An unexpected browser error occurred.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
