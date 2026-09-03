#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";

import { ConfigError, loadConfig } from "./config/index.js";
import { createBrowserMcpServer } from "./mcp/server.js";
import { createLogger, writeStderr } from "./utils/logging.js";

const SERVER_NAME = "browser-exploration-mcp";
const SERVER_VERSION = "0.1.0";

/**
 * Make a transport-ready MCP server. Browser tools are intentionally not
 * registered in this foundation layer; feature modules add them later.
 */
export function createServer(): McpServer {
  return new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const server = createBrowserMcpServer({ config, logger });

  // StdioServerTransport is the sole owner of stdout. Do not use console.log
  // or process.stdout anywhere in this process, as it would corrupt MCP JSON-RPC.
  await server.connect(new StdioServerTransport());

  logger.info("MCP transport started.", {
    connectionMode: config.connectionMode,
    browser: config.browser,
    headless: config.headless,
  });
}

function reportStartupFailure(error: unknown): void {
  if (error instanceof ConfigError) {
    writeStderr({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "Invalid server configuration.",
      variable: error.variable,
      error,
    });
    return;
  }

  writeStderr({
    timestamp: new Date().toISOString(),
    level: "error",
    message: "Unable to start the MCP server.",
    error,
  });
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    reportStartupFailure(error);
    process.exitCode = 1;
  });
}
