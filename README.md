# Browser Exploration MCP Server

An MCP server for semantic exploration of a locally installed Chrome, Chromium,
or Microsoft Edge browser over the Chrome DevTools Protocol (CDP). It does not
use WebDriver and it never downloads a browser.

## Run

After the package is published to npm, run it without a global install:

```sh
npx --yes browser-exploration-mcp
```

To run a tagged release directly from GitHub, use npm's GitHub package
specifier (replace the owner, repository, and ref):

```sh
npx --yes github:<owner>/<repository>#<tag-or-commit>
```

The package's `prepare` and `prepack` scripts build the TypeScript CLI, so the
same `bin` entry point works for npm packages and GitHub-based `npx` execution.

An MCP client configuration can use either source:

```json
{
  "mcpServers": {
    "browser-exploration": {
      "command": "npx",
      "args": ["--yes", "browser-exploration-mcp"],
      "env": {
        "BROWSER": "chrome"
      }
    }
  }
}
```

```json
{
  "mcpServers": {
    "browser-exploration": {
      "command": "npx",
      "args": ["--yes", "github:<owner>/<repository>#<tag-or-commit>"],
      "env": {
        "BROWSER": "edge"
      }
    }
  }
}
```

`BROWSER` accepts `chrome`, `chromium`, or `edge`. When it is set, startup must
use that exact browser; it must not silently fall back to another one. Browser
availability is checked by the browser-discovery layer at `browser_start`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BROWSER` | automatic discovery | Explicit browser: `chrome`, `chromium`, or `edge`. |
| `BROWSER_EXECUTABLE` | unset | Explicit local browser executable path. |
| `BROWSER_CDP_ENDPOINT` | unset | Existing `http(s)` CDP endpoint; takes precedence over launching. |
| `BROWSER_HEADLESS` | `false` | Launch headed (`false`) or headless (`true`). |
| `BROWSER_USER_DATA_DIR` | isolated temporary profile | Optional dedicated profile path. |
| `BROWSER_DOWNLOAD_DIR` | runtime-managed directory | Optional dedicated download path. |
| `BROWSER_STARTUP_TIMEOUT` | `30000` | Browser/CDP startup timeout in milliseconds. |
| `BROWSER_DEFAULT_TIMEOUT` | `10000` | Default operation timeout in milliseconds. |
| `BROWSER_MCP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |

MCP JSON-RPC owns stdout. Operational logs and startup errors are emitted only
to stderr, so they cannot corrupt the stdio protocol stream.

## Development

```sh
npm install
npm run check
npm run build
```

The current foundation starts a valid stdio MCP transport; browser tools are
registered by the browser feature modules.
