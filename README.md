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

The server uses an already installed Chromium-based browser through CDP. By
default, a launched browser reuses that browser's local user-data directory so
existing sessions can be available. To use an isolated temporary profile
instead, set `BROWSER_USE_USER_PROFILE=false` or pass
`useUserProfile: false` to `browser_start`. Reusing a profile may fail while
the normal browser is running because Chromium locks its profile; in that case
use an existing CDP endpoint or opt into an isolated profile.

It does not install Chrome, WebDriver, or any browser-driver executable.

## Tool Naming and Responses

The server provides Selenium-style names without a `browser_` prefix for the
primary actions: `click`, `fill`, `send_keys`, `press_key`, `clear`, `select`,
`check`, `uncheck`, `hover`, and `focus`. The existing `browser_*` names remain
available as compatibility aliases.

Tool inputs support `lean`, which defaults to `true`, and compact action
responses are returned by default. Use `lean: false` with
`observeMode: "full"` when a complete page snapshot is required. `limit`
controls the number of interactables in compact observations, and `verbose`
includes optional bounds and viewport metadata.

`fill` replaces the current value using keyboard input and supports
`commit: "none" | "blur" | "Tab" | "Enter"`. `clear` uses the same commit
options and action results include `readBackValue` for text-capable controls.
Use `force: true` with `click` only when a hidden or obscured control requires
the controlled DOM-click fallback; the response identifies this with
`actionHint: "javascript_click"`.

An MCP client configuration can use either source:

```json
{
  "mcpServers": {
    "browser-exploration": {
      "command": "npx",
      "args": [
        "--yes",
        "github:parthvenkatesh/browser-mcp#latest"
      ],
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
      "args": [
        "--yes",
        "github:parthvenkatesh/browser-mcp#latest"
      ],
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
| `BROWSER_USER_DATA_DIR` | detected browser profile | Explicit user-data directory override. |
| `BROWSER_USE_USER_PROFILE` | `true` | Reuse the selected browser's normal user-data directory when launching. |
| `BROWSER_DOWNLOAD_DIR` | runtime-managed directory | Optional dedicated download path. |
| `BROWSER_STARTUP_TIMEOUT` | `30000` | Browser/CDP startup timeout in milliseconds. |
| `BROWSER_DEFAULT_TIMEOUT` | `10000` | Default operation timeout in milliseconds. |
| `BROWSER_MCP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |

MCP JSON-RPC owns stdout. Operational logs and startup errors are emitted only
to stderr, so they cannot corrupt the stdio protocol stream.

When user-profile mode is enabled, the detected directories are:

- macOS Chrome: `~/Library/Application Support/Google/Chrome`
- macOS Chromium: `~/Library/Application Support/Chromium`
- macOS Edge: `~/Library/Application Support/Microsoft Edge`
- Windows Chrome: `%LOCALAPPDATA%\\Google\\Chrome\\User Data`
- Windows Chromium: `%LOCALAPPDATA%\\Chromium\\User Data`
- Windows Edge: `%LOCALAPPDATA%\\Microsoft\\Edge\\User Data`

The server only terminates browser processes that it launched and never
deletes user-owned profile data.

## Development

```sh
npm install
npm run check
npm run build
```

For a pinned MCP configuration, replace `#latest` with a version tag such as
`#v0.1.0`. If npm reports a 404, verify the repository is public, the tag
exists on GitHub, and the GitHub specifier uses `#ref` rather than `>#ref`.
