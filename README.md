# Browser Exploration MCP Server

An MCP server for semantic exploration of a locally installed Chrome, Chromium,
or Microsoft Edge browser over the Chrome DevTools Protocol (CDP). It does not
use WebDriver and it never downloads a browser.

## Run

Run the latest release directly from the public GitHub repository without a
local checkout or global install:

```sh
npx --yes github:parthvenkatesh/browser-mcp#latest
```

The `latest` tag is a mutable release alias maintained by the project. For a
reproducible installation, pin an immutable version tag:

```sh
npx --yes github:parthvenkatesh/browser-mcp#v0.1.0
```

The repository must be public and users need Node.js 20.11 or newer, npm, and
Git/network access. npm runs the package `prepare` script during installation,
which builds the TypeScript CLI before it starts. Do not use `--ignore-scripts`.

The server uses an already installed Chromium-based browser through CDP. It
does not install Chrome, WebDriver, or any browser-driver executable.

An MCP client configuration can use either source:

```json
{
  "mcpServers": {
    "browser-exploration": {
      "command": "npx",
      "args": ["--yes", "github:parthvenkatesh/browser-mcp#latest"],
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
      "args": ["--yes", "github:parthvenkatesh/browser-mcp#latest"],
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

For a pinned MCP configuration, replace `#latest` with a version tag such as
`#v0.1.0`. If npm reports a 404, verify the repository is public, the tag
exists on GitHub, and the GitHub specifier uses `#ref` rather than `>#ref`.
