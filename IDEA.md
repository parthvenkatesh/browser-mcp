Browser Exploration MCP Server
Objective
Build a production-quality, cross-platform Browser Exploration MCP Server for macOS and Windows.

The MCP server will provide an AI agent with controlled access to a locally installed Chromium-based browser. Its primary responsibility is to open, inspect, observe, and interact with web applications.

The MCP server should expose a semantic browser interface rather than exposing raw browser internals.

The AI agent should be able to:

Observe current browser state
        ↓
Discover interactable elements
        ↓
Perform an interaction
        ↓
Observe the resulting state
        ↓
Repeat

The MCP server itself should remain focused on browser access and exploration. It should not implement workflow generation, no-code logic, business reasoning, or automation planning.

Critical Requirement: No WebDriver
Do not use:

Selenium
WebDriver
ChromeDriver
EdgeDriver
GeckoDriver
Any browser-driver executable
The browser must be controlled using Chrome DevTools Protocol (CDP).

The server must use the browser already installed on the user's machine.

Do not automatically download or install another browser.

The intended architecture is:

MCP Client
    │
    │ MCP
    ▼
Browser Exploration MCP Server
    │
    │ CDP
    ▼
Installed Chromium Browser

Supported Browsers
Initially support Chromium-based browsers:

Google Chrome
Chromium
Microsoft Edge
Design browser discovery so additional Chromium-based browsers can be added later.

Supported Operating Systems
The implementation must work on:

macOS
Windows
Browser Discovery
Implement a browser discovery module.

The server should automatically locate supported browsers using platform-specific known paths.

macOS
Consider paths such as:

/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome

/Applications/Chromium.app/Contents/MacOS/Chromium
~/Applications/Chromium.app/Contents/MacOS/Chromium

/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge
~/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge

Windows
Consider paths such as:

C:\Program Files\Google\Chrome\Application\chrome.exe
C:\Program Files (x86)\Google\Chrome\Application\chrome.exe

C:\Program Files\Microsoft\Edge\Application\msedge.exe
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe

C:\Program Files\Chromium\Application\chrome.exe

Also check PATH where appropriate.

Allow an explicit executable override:

BROWSER_EXECUTABLE=/path/to/browser

or the Windows equivalent.

Allow selecting the browser:

BROWSER=chrome

Possible values:

chrome
chromium
edge

If no browser can be found, return a useful diagnostic containing:

browsers searched for
locations checked
configured executable, if any
instructions for specifying an executable manually
Browser Launching
The MCP server should be able to launch the browser itself.

Find an unused localhost TCP port dynamically.

Launch the browser with:

--remote-debugging-port=<port>

Use a dedicated browser profile:

--user-data-dir=<profile>

The default should be an isolated temporary profile.

Do not use the user's normal Chrome profile by default.

Example macOS command:

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/browser-mcp

Example Windows command:

"C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\browser-mcp"

The actual implementation should dynamically allocate the port rather than hard-code 9222.

Existing Browser / CDP Connection
Support a second mode where the MCP server connects to an already-running browser.

For example:

BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222

In this mode:

MCP Server
    │
    │ CDP
    ▼
Existing Browser

Do not launch another browser when a valid CDP endpoint is explicitly configured.

Browser Profiles
Support two modes.

Isolated profile
Default behavior.

Create a dedicated browser profile for the MCP server.

This prevents accidental interaction with the user's normal browser profile.

Existing CDP session
Advanced behavior.

Connect to an explicitly supplied CDP endpoint.

Document that this may provide access to authenticated websites and existing browser sessions.

Never silently use the user's normal browser profile.

MCP Transport
Use the current MCP SDK.

Prefer:

Node.js
TypeScript

Use stdio transport as the primary MCP transport.

Architecture:

MCP Client
    │
    │ stdin/stdout
    ▼
MCP Server
    │
    ▼
Browser/CDP

Do not write logs to stdout because stdout is reserved for MCP protocol communication.

Write logs to stderr or a configurable log file.

MCP Tool Design
The tools should operate at a semantic browser level.

Do not expose raw CDP commands as the primary interface.

The agent should not need to know:

CDP
CSS selectors
XPath
DOM node IDs
browser process IDs
accessibility-tree internals
These are implementation details.

Tool: browser_start
Start or connect to a browser.

Example:

{
  "browser": "chrome"
}

Possible behavior:

Detect browser.
Allocate CDP port.
Create isolated profile.
Launch browser.
Wait for CDP.
Connect to CDP.
Create/select the initial page.
Return useful browser information:

{
  "browser": "chrome",
  "version": "...",
  "cdpConnected": true,
  "headless": false
}

Tool: browser_status
Return the current browser state.

Include:

browser
connection status
active tab
number of tabs
current URL
current page title
Tool: browser_close
Close the browser session created by the MCP server.

Clean up:

browser process
CDP connection
temporary profile
temporary resources
Do not terminate externally managed browsers when using an externally supplied CDP endpoint unless explicitly requested.

Tool: browser_navigate
Navigate the active page.

Input:

{
  "url": "https://example.com"
}

Wait for the navigation to reach a useful state.

Return:

final URL
page title
navigation status
optionally a concise page observation
Handle redirects.

Tool: browser_back
Navigate backward.

Tool: browser_forward
Navigate forward.

Tool: browser_reload
Reload the current page.

Tool: browser_observe
This is the primary MCP tool.

It should inspect the current application and return a semantic representation of the visible page.

The output should be optimized for consumption by an AI agent.

Example:

Page: Customers

URL:
https://example.com/customers

Title:
Customers

INTERACTABLES

[e1] link "Dashboard"
[e2] link "Customers"
[e3] link "Contacts"

[e4] textbox "Search customers"

[e5] button "Create customer"

CUSTOMER TABLE

[r1] row "Acme Corporation"
    Company: Acme Corporation
    Contact: John Smith
    Status: Active
    [e6] button "Actions"

[r2] row "Globex"
    Company: Globex
    Contact: Jane Doe
    Status: Active
    [e7] button "Actions"

DIALOGS

None

NOTIFICATIONS

None

The response may also provide structured JSON if that is more appropriate for MCP clients.

Semantic Observation
The observation engine should combine information from:

DOM
Accessibility tree
ARIA roles
accessible names
labels
visible text
placeholders
input types
enabled/disabled state
visibility
bounding boxes
semantic relationships
forms
tables
dialogs
menus
tabs
Prefer accessibility information when available.

Use DOM information to supplement missing information.

Interactable Detection
Detect common interactable elements.

Actions
Identify:

buttons
links
menu items
tabs
clickable elements
clickable cards
icon buttons
dropdown options
Inputs
Identify:

textboxes
textareas
search fields
number inputs
date inputs
password inputs
checkboxes
radio buttons
comboboxes
selects
sliders
Containers / structures
Identify:

forms
tables
rows
lists
dialogs
drawers
menus
popovers
accordions
tabs
Semantic Element Model
Create an internal normalized representation.

For example:

interface Interactable {
  ref: string;

  role:
    | "button"
    | "link"
    | "textbox"
    | "checkbox"
    | "radio"
    | "combobox"
    | "option"
    | "tab"
    | "menuitem"
    | "row"
    | "other";

  name?: string;
  text?: string;
  placeholder?: string;
  value?: string;

  visible: boolean;
  enabled: boolean;

  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  parentRef?: string;

  locator?: {
    strategy: string;
    value: string;
  };
}

The locator is an internal implementation detail.

Do not require the MCP client to provide CSS/XPath locators when an element reference can be used.

Element References
Every relevant interactable should receive a short reference.

Example:

[e1] textbox "Email"
[e2] textbox "Password"
[e3] button "Sign in"

The MCP client can then call:

{
  "ref": "e3"
}

The server resolves the reference internally.

References should be scoped to the current page/state.

When the page undergoes a major navigation or rerender, stale references should be invalidated.

Tool: browser_click
Click an element.

Input:

{
  "ref": "e3"
}

The server should:

Resolve the element.
Verify that it is visible.
Verify that it is enabled.
Scroll it into view if necessary.
Click it.
Wait for meaningful application activity.
Detect whether the application state changed.
Return the resulting state summary.
Do not simply return:

success

Instead return useful information such as:

Click succeeded.

Previous state:
customers

New state:
create_customer

URL:
https://example.com/customers/new

New interactables:
[e1] textbox "Company name"
[e2] textbox "Email"
[e3] combobox "Account owner"
[e4] button "Save"

Tool: browser_fill
Fill an input.

Input:

{
  "ref": "e1",
  "value": "Acme Corporation"
}

Prefer setting the value in a way that correctly triggers the framework's input/change events.

This is important for React, Vue, Angular, and other modern applications.

Tool: browser_type
Type text into an element.

Input:

{
  "ref": "e1",
  "text": "Acme"
}

This should simulate actual keyboard input where appropriate.

Tool: browser_press
Press a keyboard key.

Example:

{
  "ref": "e1",
  "key": "Enter"
}

Support common keys:

Enter
Tab
Escape
ArrowUp
ArrowDown
ArrowLeft
ArrowRight
Backspace
Delete
Space

Tool: browser_select
Select an option from a select/combobox.

Example:

{
  "ref": "e1",
  "value": "active"
}

Where possible, support both option value and visible option text.

Tool: browser_check
Check a checkbox.

Tool: browser_uncheck
Uncheck a checkbox.

Tool: browser_hover
Hover over an element.

Useful for:

tooltips
menus
hover actions
hidden controls
After hovering, detect whether the UI changed.

Tool: browser_focus
Focus an element.

Tool: browser_wait
Wait for a meaningful browser condition.

Avoid implementing this as only:

sleep(milliseconds)

Support conditions such as:

network idle
navigation
element visible
element enabled
text appears
text disappears

Example:

{
  "condition": "text_visible",
  "text": "Customer created",
  "timeout": 10000
}

Tool: browser_wait_for_element
Wait for an element matching semantic criteria.

Example:

{
  "role": "button",
  "name": "Save",
  "timeout": 10000
}

Tool: browser_screenshot
Capture the current page.

Support:

viewport screenshot
full-page screenshot where possible
Example:

{
  "fullPage": true
}

Where possible, associate element references with their bounding boxes so the AI agent can relate semantic elements to the screenshot.

Tool: browser_list_tabs
Return all open tabs/pages.

Example:

tab-1
  URL: https://example.com
  Title: Dashboard
  Active: true

tab-2
  URL: https://example.com/settings
  Title: Settings
  Active: false

Tool: browser_new_tab
Create a new tab.

Optional URL:

{
  "url": "https://example.com"
}

Tool: browser_switch_tab
Switch the active tab.

Example:

{
  "tabId": "tab-2"
}

Tool: browser_close_tab
Close a tab.

Tool: browser_evaluate
Provide controlled JavaScript evaluation in the current page context.

Example:

{
  "expression": "document.title"
}

This should execute in the page context.

Do not expose Node.js filesystem access, shell access, or other local-machine capabilities through this tool.

Return JavaScript errors clearly.

Page State
The MCP server should maintain lightweight state information.

A state can be derived from:

URL
page title
visible dialogs
relevant DOM structure
accessibility structure
major application changes
Example:

state_1
/dashboard

      ↓ click Customers

state_2
/customers

      ↓ click Create customer

state_3
/customers/new

The state model does not need to perfectly identify every DOM mutation.

Its purpose is to detect meaningful application changes and help invalidate stale element references.

State Changes
After an interaction, determine whether the application state changed.

Possible state changes include:

URL changed
SPA route changed
modal opened
modal closed
menu opened
tab changed
form appeared
table changed
notification appeared
significant DOM/accessibility structure changed
Return a concise state transition where possible.

Example:

State changed:

Before:
  /customers

After:
  /customers/123

Reason:
  URL changed

SPA Support
The MCP server must support modern single-page applications.

Do not assume every action causes a full page navigation.

Support state changes caused by:

React
Vue
Angular
Next.js
Remix
client-side routing
fetch/XHR
dynamic DOM updates
modals
drawers
tabs
dropdowns
Use CDP events, DOM observation, and appropriate waiting strategies.

Forms
The observation system should recognize forms and their relationships.

Example:

FORM: Create Customer

[e1] textbox "Company name"
[e2] textbox "Email"
[e3] textbox "Phone"
[e4] combobox "Account owner"
[e5] checkbox "Active"
[e6] button "Save"

Correctly associate:

label → input

even when labels and inputs are not direct siblings.

Tables
Represent tables semantically.

Example:

TABLE: Customers

Columns:
  Company
  Contact
  Status
  Actions

[r1] row "Acme Corporation"
  Company: Acme Corporation
  Contact: John Smith
  Status: Active
  [e1] button "Actions"

[r2] row "Globex"
  Company: Globex
  Contact: Jane Doe
  Status: Inactive
  [e2] button "Actions"

Avoid returning enormous raw table HTML.

Dialogs and Overlays
Detect:

dialogs
modals
drawers
popovers
menus
tooltips
When a dialog is open, clearly identify it in the observation.

Example:

DIALOG: Delete customer

[e1] button "Cancel"
[e2] button "Delete"

Prefer elements inside the active dialog when resolving ambiguous references.

Visibility
An element should only be presented as interactable if it is meaningfully visible.

Consider:

CSS display
CSS visibility
opacity where appropriate
bounding box
viewport position
hidden ancestors
disabled state
overlays
Do not expose hundreds of hidden template elements.

Element Resolution
When resolving a reference, use a robust strategy.

Possible priority:

Current DOM identity where available.
Stable attributes.
Accessibility role/name.
Associated label.
Semantic text.
CSS selector.
XPath as a last resort.
Avoid relying on generated framework-specific class names.

For example, do not prefer:

.MuiBox-root.css-1abc123

over:

button[name="Create customer"]

Stale References
If a reference becomes invalid:

Element ref=e7 is stale.

The page/application state changed after the previous observation.

Call browser_observe to obtain fresh element references.

Do not silently click a different element just because it happens to have similar text.

Waiting Strategy
Do not rely on arbitrary sleeps.

Use:

CDP navigation events
DOM events
lifecycle events
network activity where appropriate
element visibility
element enabled state
mutation observation
application-specific observable changes
Provide configurable default timeouts.

Error Handling
Errors should be useful to an AI agent.

Examples:

Browser not found.

Supported browsers:
  Chrome
  Chromium
  Edge

Searched:
  /Applications/Google Chrome.app/...
  ...

Set BROWSER_EXECUTABLE to specify the browser manually.

Another example:

Unable to click ref=e4.

The element exists but is currently disabled.

Current state:
  /customers/new

Suggested action:
  Observe the page and determine whether required fields must be completed first.

Another:

Unable to connect to CDP endpoint.

Endpoint:
  http://127.0.0.1:9222

Verify that the browser was started with remote debugging enabled.

Security
CDP must bind to localhost by default:

127.0.0.1

Never expose CDP publicly unless explicitly configured.

Do not expose:

arbitrary shell commands
arbitrary filesystem operations
OS-level automation
through MCP.

JavaScript evaluation must remain inside the browser page context.

Use isolated browser profiles by default.

Configuration
Support configuration similar to:

BROWSER=chrome
BROWSER_EXECUTABLE=
BROWSER_CDP_ENDPOINT=
BROWSER_HEADLESS=false

BROWSER_USER_DATA_DIR=
BROWSER_DOWNLOAD_DIR=

BROWSER_STARTUP_TIMEOUT=30000
BROWSER_DEFAULT_TIMEOUT=10000

Use sensible defaults.

Document every option.

Headless Mode
Support both:

BROWSER_HEADLESS=true

and:

BROWSER_HEADLESS=false

Default to headed mode.

The primary use case is interactive exploration of applications.

Downloads
If downloads are supported, configure a dedicated download directory.

Do not expose arbitrary filesystem access through MCP.

A future tool may provide controlled download information, but this should remain scoped to the browser's configured download directory.

Cookies and Storage
If implemented, expose controlled browser-context operations for:

browser_get_cookies
browser_set_cookie
browser_clear_cookies

browser_get_local_storage
browser_set_local_storage

Keep these scoped to the current browser context.

Do not expose passwords or credentials.

Project Architecture
Use a modular architecture similar to:

src/

  index.ts

  mcp/
    server.ts
    tools/
      browser.ts
      navigation.ts
      observation.ts
      interaction.ts
      tabs.ts
      screenshot.ts
      evaluation.ts

  browser/
    BrowserManager.ts
    BrowserDetector.ts
    BrowserLauncher.ts
    CdpConnection.ts
    PageManager.ts

  exploration/
    Observer.ts
    AccessibilityTree.ts
    DomAnalyzer.ts
    InteractableDetector.ts
    SemanticModel.ts
    StateTracker.ts
    ElementRegistry.ts

  interaction/
    Click.ts
    Input.ts
    Keyboard.ts
    Select.ts

  platform/
    macos.ts
    windows.ts

  config/
    Config.ts

  utils/
    ports.ts
    logging.ts

The exact structure can be changed if a better design is appropriate.

Keep these layers separate:

MCP layer
    ↓
Browser management
    ↓
CDP
    ↓
Exploration / semantic analysis
    ↓
DOM / accessibility / browser

Recommended Technology
Use:

Node.js
TypeScript
MCP SDK
CDP-compatible browser library

A maintained CDP library such as Puppeteer may be used if appropriate.

The important constraint is that it must control the user's installed Chromium browser through CDP.

It must not require a WebDriver executable.

It must not silently download another browser.

Testing
Provide unit tests for:

Browser detection
Test:

macOS Chrome
macOS Chromium
macOS Edge
Windows Chrome
Windows Edge
custom executable
browser not found
Mock platform and filesystem detection where appropriate.

Browser/CDP
Test:

browser launch
CDP connection
page creation
navigation
observation
interaction
screenshots
tab management
Semantic observation
Test detection of:

buttons
links
textboxes
checkboxes
radio buttons
comboboxes
tabs
menu items
dialogs
forms
tables
rows
disabled elements
hidden elements
MCP
Test:

tool registration
input validation
successful operations
stale references
browser disconnection
useful error messages
Separate unit tests from real-browser integration tests when necessary.

Logging
Never write diagnostic logs to stdout when using stdio MCP transport.

Use stderr.

Provide useful debug logging for:

browser discovery
browser launch
CDP connection
navigation
state changes
interaction failures
browser crashes
Allow configurable log levels.

README
Create comprehensive documentation covering:

installation
prerequisites
macOS setup
Windows setup
supported browsers
browser discovery
configuration
starting the MCP server
MCP client configuration
isolated browser profiles
connecting to an existing CDP browser
security considerations
available MCP tools
example MCP interactions
troubleshooting
Explicitly state:

No WebDriver or browser-driver installation is required.

Deliverables
Produce a complete working project containing:

MCP server implementation.
CDP browser manager.
Cross-platform browser detection.
Browser lifecycle management.
Semantic page observation.
Interactable detection.
Element-reference system.
Navigation tools.
Interaction tools.
Tab management.
Screenshot support.
State tracking.
Robust waiting.
Error handling.
Security controls.
Unit tests.
Browser integration tests.
README.
Example MCP configuration.
Run and fix:

npm/pnpm install
build
typecheck
lint
tests

before completing the implementation.

Non-Goals
Do NOT implement:

no-code workflow generation
workflow orchestration
business-rule reasoning
automation planning
trigger/action modeling
workflow persistence
application-specific business logic
AI/LLM reasoning
WebDriver support
The MCP server should provide only the browser capabilities required by an external AI agent.

Final Design Principle
The MCP server should make a complex web application look like a structured, observable environment:

Browser
  └── Page
       ├── State
       ├── Navigation
       ├── Forms
       ├── Tables
       ├── Dialogs
       ├── Elements
       │    ├── Buttons
       │    ├── Links
       │    ├── Inputs
       │    ├── Selects
       │    └── Other interactables
       └── Notifications

The external AI agent should be able to repeatedly perform:

browser_observe
      ↓
choose an element
      ↓
browser_click / browser_fill / browser_select / ...
      ↓
observe resulting state
      ↓
repeat