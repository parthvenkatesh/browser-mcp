import * as http from "node:http";
import * as https from "node:https";

import puppeteer, { type Browser } from "puppeteer-core";

import { BrowserConnectionError } from "./errors.js";

export interface CdpVersionInfo {
  readonly browser: string;
  readonly protocolVersion?: string;
  readonly userAgent?: string;
  readonly webSocketDebuggerUrl?: string;
}

export interface WaitForCdpOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly isProcessRunning?: () => boolean;
}

/** Ensure an HTTP CDP URL has no trailing slash or endpoint subpath. */
export function normalizeCdpEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch (cause) {
    throw new BrowserConnectionError(endpoint, cause);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new BrowserConnectionError(endpoint, new Error("CDP endpoint must use http(s) or ws(s)."));
  }

  // An HTTP endpoint can be supplied as /json/version by habit. Puppeteer
  // needs the root browser URL, while our probe specifically adds that path.
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
  }
  return parsed.toString().replace(/\/$/, "");
}

/** Whether an endpoint is a direct CDP WebSocket URL rather than HTTP(S). */
export function isWebSocketCdpEndpoint(endpoint: string): boolean {
  const normalized = normalizeCdpEndpoint(endpoint);
  const protocol = new URL(normalized).protocol;
  return protocol === "ws:" || protocol === "wss:";
}

export async function getCdpVersion(endpoint: string, timeoutMs = 1_500): Promise<CdpVersionInfo> {
  const normalized = normalizeCdpEndpoint(endpoint);
  if (isWebSocketCdpEndpoint(normalized)) {
    throw new BrowserConnectionError(normalized, new Error("A WebSocket endpoint does not expose /json/version."));
  }

  const url = new URL("/json/version", `${normalized}/`);
  const request = url.protocol === "https:" ? https.get : http.get;

  return new Promise<CdpVersionInfo>((resolve, reject) => {
    let settled = false;

    function finishWithError(cause: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new BrowserConnectionError(normalized, cause));
    }

    function finishWithValue(value: CdpVersionInfo): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    const req = request(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      response.on("error", finishWithError);
      response.on("end", () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          finishWithError(new Error(`CDP endpoint returned HTTP ${response.statusCode ?? "unknown"}.`));
          return;
        }

        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          if (typeof parsed.Browser !== "string") {
            finishWithError(new Error("CDP /json/version response did not include Browser."));
            return;
          }
          finishWithValue({
            browser: parsed.Browser,
            protocolVersion: typeof parsed["Protocol-Version"] === "string" ? parsed["Protocol-Version"] : undefined,
            userAgent: typeof parsed["User-Agent"] === "string" ? parsed["User-Agent"] : undefined,
            webSocketDebuggerUrl:
              typeof parsed.webSocketDebuggerUrl === "string" ? parsed.webSocketDebuggerUrl : undefined,
          });
        } catch (cause) {
          finishWithError(cause);
        }
      });
    });

    const timer = setTimeout(() => {
      finishWithError(new Error(`Timed out querying ${url.toString()}.`));
      req.destroy();
    }, timeoutMs);
    timer.unref();

    req.once("error", finishWithError);
  });
}

/** Wait for a just-launched local browser to expose its CDP metadata. */
export async function waitForCdpEndpoint(
  endpoint: string,
  options: WaitForCdpOptions = {},
): Promise<CdpVersionInfo> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    if (options.isProcessRunning && !options.isProcessRunning()) {
      throw new BrowserConnectionError(endpoint, new Error("The browser process exited before CDP became available."));
    }

    try {
      return await getCdpVersion(endpoint, Math.min(1_000, timeoutMs));
    } catch (error) {
      lastError = error;
      await delay(pollIntervalMs);
    }
  }

  if (lastError instanceof BrowserConnectionError) {
    throw lastError;
  }
  throw new BrowserConnectionError(endpoint, lastError);
}

export async function connectToBrowser(endpoint: string): Promise<Browser> {
  const normalized = normalizeCdpEndpoint(endpoint);
  try {
    if (isWebSocketCdpEndpoint(normalized)) {
      return await puppeteer.connect({ browserWSEndpoint: normalized, defaultViewport: null });
    }
    return await puppeteer.connect({ browserURL: normalized, defaultViewport: null });
  } catch (cause) {
    throw new BrowserConnectionError(normalized, cause);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
