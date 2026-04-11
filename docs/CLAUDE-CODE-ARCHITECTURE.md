# Claude Code Architecture - Reverse Engineering Notes

Reverse-engineered from VS Code extension v2.1.78 and npm CLI package v2.1.29.
Dated 2026-03-18.

## Overview

Claude Code has three layers:

```
VS Code Extension (extension.js, ~1.5MB minified)
  |  spawns + communicates via stdin/stdout JSON messages
  v
Claude CLI (cli.js or native binary)
  |  owns all state: conversation, MCP connections, tool registry
  v
Claude API (api.anthropic.com)
```

The VS Code extension is a thin UI wrapper. It bundles the Claude Agent SDK
(TypeScript) which spawns the CLI as a child process and communicates over
stdin/stdout using a JSON-based IPC protocol.

## Distribution and the CLI/SDK relationship

Claude Code's runtime (the full conversation loop, MCP client management, tool
execution, etc.) is a single codebase that ships in two forms:

- **npm package** (`@anthropic-ai/claude-code`): Contains `cli.js`, a ~11MB
  bundled Node.js script. The `claude` bin entry points to this file.
- **Native binary** (Homebrew cask `claude-code`): A compiled Mach-O ARM64
  binary at `/opt/homebrew/Caskroom/claude-code/<version>/claude`.

Both are the same codebase - `cli.js` IS the Claude CLI, not a wrapper around
the binary. The native binary is the same code compiled to a standalone
executable. They are functionally equivalent and interchangeable.

The **Claude Agent SDK** (`@anthropic-ai/claude-code` TypeScript SDK) is a
library for spawning a Claude Code subprocess (either `cli.js` or the native
binary) and communicating with it over stdin/stdout JSON IPC. It does not contain
the CLI logic itself - it is a client that drives the CLI as a child process.

```
Claude Agent SDK (spawner/client library)
  |  spawns one of:
  +-- cli.js (Node.js bundle, ~11MB)
  +-- native binary (Mach-O, Homebrew)
  |
  |  communicates via stdin/stdout JSON messages
  v
Claude Code Runtime (inside the spawned process)
  |  owns all state: conversation, MCP connections, tool registry
  v
Claude API (api.anthropic.com)
```

## VS Code Extension

**Location**: `~/.vscode/extensions/anthropic.claude-code-<version>-<platform>/`

**Key files**:

- `extension.js` - Single minified bundle (~1.5MB, ~78K lines beautified)
- `package.json` - Extension manifest
- `webview/index.js` - Webview UI bundle (~4.8MB minified, ~247K lines beautified)
- `webview/index.css` - Webview styles

**Architecture**: The extension bundles the Claude Agent SDK and uses it to spawn
a CLI subprocess. It detects which form to use by checking the file extension -
if the path ends in `.js`/`.mjs`/`.tsx`/`.ts`/`.jsx` it runs via Node.js;
otherwise it spawns the native binary directly. All conversation state, tool
execution, and MCP management happens in the CLI process. The extension handles:

- VS Code integration (status bar, webview panels, commands)
- Process lifecycle (spawn, kill, reconnect)
- UI rendering for MCP server management, auth flows, etc.

### Webview UI

The chat interface is a React application rendered in a VS Code webview panel.
It bundles Monaco Editor for code block display and uses Preact signals for
state management. The webview communicates with the extension host via
`postMessage`.

#### Chat input

The input is a **`contentEditable="plaintext-only"` div** (not a textarea).
Key features:

| Feature                       | Implementation                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **@ mentions**                | Typing `@` triggers an autocomplete popup for files, folders, URLs, browser tabs. A hidden `mentionMirror` div tracks mention positions for alignment. |
| **Slash commands**            | Typing `/` opens a command menu (`/compact`, `/config`, `/help`, `/terminal`, custom skills). Also triggered via toolbar button.                       |
| **File attachment**           | Toolbar button opens native file picker. Files shown as removable chips below the input.                                                               |
| **Image paste**               | Clipboard items checked for `image/*` type on paste.                                                                                                   |
| **Drag and drop**             | Drop overlay ("Drop to attach as context") shown on drag-over. Files dropped on the chat container are attached.                                       |
| **Speech-to-text**            | Mic button when input is empty. Supports toggle (click) and push-to-talk (hold). Visual recording indicator.                                           |
| **Inline prompt suggestion**  | CLI pushes `prompt_suggestion` messages rendered as ghost text in the input. Accepted via Tab. Tracked for analytics.                                  |
| **Message truncation**        | Input capped at 50,000 characters with truncation notice.                                                                                              |
| **VS Code selection context** | "Include selection" toggle to attach current editor selection as context.                                                                              |

#### Input footer toolbar

Left to right:

1. **@ context button** - Opens attachment menu (upload, add context, browse web)
2. **/ command menu button** - Opens slash command list
3. **Context usage indicator** - Shows `X% context used` as a progress bar
   (`usedTokens / contextWindow`). Clickable to trigger `/compact`. Only
   visible when usage exceeds 50%.
4. **Selection context toggle** - Shows current file selection
5. **Spacer**
6. **Permission mode + effort selector** - Combined dropdown for mode
   (default/acceptEdits/plan) and effort level (low/medium/high)
7. **Send/Stop button** - Send arrow or stop square depending on busy state

#### Message rendering

Messages are rendered in a **timeline layout** with turns. Each turn contains
groups of messages that can be collapsed.

| Block type      | Rendering                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Text**        | Markdown with syntax highlighting                                                                                   |
| **Thinking**    | Collapsible blocks with per-message and global expand toggle (`areThinkingBlocksExpanded`)                          |
| **Tool use**    | Grouped into collapsible sections when sequential. Shows tool name, input, output. Count badge on collapsed groups. |
| **Tool result** | Shown within tool groups, truncated for large outputs                                                               |
| **Code blocks** | Monaco Editor instances (full syntax highlighting via `vscode-chat-code-block` URI scheme)                          |

Message status dots per turn: `dotSuccess` (green), `dotFailure` (red),
`dotProgress` (animated).

#### Interactive elements

- **Permission requests**: Dedicated container below messages, above input.
  Shows tool name, input preview, allow/deny buttons. Chat area dimmed while
  active.
- **Plan mode**: Three modes via dropdown - `default`, `acceptEdits`, `plan`.
  Plan review opens a markdown preview panel (`open_markdown_preview`) where
  users can add comments (`get_plan_comments`, `remove_plan_comment`) and
  approve/reject (`close_plan_preview`).
- **Conversation forking**: `fork_conversation` dispatched to extension host,
  which uses `forkSession` + `resumeSessionAt` from the SDK.
- **Code rewind**: `rewind_code` with target message ID. Highlighted message
  state in UI.

#### Status indicators

| Indicator             | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| **Context usage bar** | Token-based progress bar, clickable to compact. Only shown > 50% used. |
| **Loading state**     | "Loading..." during session initialization                             |
| **Error banner**      | Dismissible error with message and retry link                          |
| **Busy/streaming**    | Send button becomes stop button. Messages show progress dots.          |
| **Compact boundary**  | Synthetic message inserted when context compaction occurs              |
| **Drop overlay**      | "Drop to attach as context" during drag-over                           |

#### Thinking/activity spinner

The webview has an animated thinking indicator (`jH1` component) that shows
while the agent is working. It has three layers of animation:

1. **Symbol prefix**: Cycles through `["·", "✢", "*", "✶", "✻", "✽"]` in a
   ping-pong pattern every 120ms
2. **Rotating verb**: Randomly selected from ~70 playful verbs ("Pondering",
   "Brewing", "Noodling", "Cogitating", "Spelunking", etc.), changing at
   escalating intervals: 2s, 3s, 5s, then every 5s thereafter
3. **Typewriter transition**: New verb text animates character-by-character via
   `requestAnimationFrame` at ~40ms per character with a 3-character blur trail

The verb list is configurable via `spinnerVerbsConfig` (replace or extend).
When status is `"compacting"`, the verb is overridden to "Compacting".
Text is padded to the max verb length to prevent layout shifts.

#### Keyboard shortcuts (webview)

- **Enter** - Submit message
- **Ctrl/Cmd+C** - Interrupt when busy (via extension host)
- **Escape** - Close dialogs
- **Tab** - Accept inline prompt suggestion

## IPC Protocol

The extension and CLI communicate via a **newline-delimited JSON protocol over
stdin/stdout pipes**. Each message is one JSON object per line. The parent
process (extension/SDK) writes to the CLI's stdin; the CLI writes responses to
its stdout. This is the only way to send control messages to the CLI - there is
no HTTP API, Unix socket, or file-based signaling.

### Message format

Requests from the SDK/extension to the CLI are wrapped as:

```json
{
    "request_id": "<random-alphanumeric>",
    "type": "control_request",
    "request": { "subtype": "mcp_reconnect", "serverName": "my-server" }
}
```

Responses from the CLI are matched back by `request_id`:

```json
{ "request_id": "<same-id>", "subtype": "success" }
{ "request_id": "<same-id>", "subtype": "error", "error": "..." }
```

The SDK (`yP` class in the extension bundle) maintains a `pendingControlResponses`
map keyed by `request_id`. When a response arrives on stdout, it routes it to the
original Promise's resolve/reject handler.

### Full message flow example (MCP reconnect)

```
1. User clicks "Reconnect" in VS Code webview
2. Webview posts message to extension: {case: "reconnect_mcp_server", ...}
3. Extension dispatch handler calls channel.query.reconnectMcpServer(name)
4. SDK's conversation controller (yP) builds a control_request:
   {request_id: "abc123", type: "control_request",
    request: {subtype: "mcp_reconnect", serverName: "my-server"}}
5. SDK calls transport.write(JSON.stringify(message) + "\n")
6. ProcessTransport (TP) writes the JSON line to the CLI's process.stdin pipe
7. CLI reads the line from its stdin, dispatches on subtype
8. CLI performs disconnect + reconnect internally
9. CLI writes response JSON line to its stdout
10. ProcessTransport reads it via readline on process.stdout
11. SDK matches request_id, resolves the pending Promise
```

### Request subtypes (extension -> CLI)

| Subtype                   | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `initialize`              | Initialize the CLI session                     |
| `interrupt`               | Interrupt current operation                    |
| `mcp_reconnect`           | Reconnect a specific MCP server                |
| `mcp_toggle`              | Enable/disable a specific MCP server           |
| `mcp_set_servers`         | Update the full MCP server configuration       |
| `mcp_status`              | Query MCP server status                        |
| `mcp_message`             | Forward a message to an MCP server's transport |
| `rewind_files`            | Revert files to a prior state                  |
| `set_model`               | Change the active model                        |
| `set_permission_mode`     | Change permission mode                         |
| `set_max_thinking_tokens` | Change thinking token budget                   |

### Response subtypes (CLI -> extension)

| Subtype             | Description                  |
| ------------------- | ---------------------------- |
| `init`              | Initialization response      |
| `status`            | Status update                |
| `success`           | Operation completed          |
| `error`             | Error occurred               |
| `api_error`         | Claude API error             |
| `can_use_tool`      | Tool permission prompt       |
| `hook_started`      | Hook execution started       |
| `hook_response`     | Hook execution result        |
| `hook_progress`     | Hook progress update         |
| `hook_callback`     | Hook callback                |
| `plan_approval`     | Plan mode approval prompt    |
| `compact_boundary`  | Context compaction occurred  |
| `task_notification` | Background task notification |
| `shutdown`          | CLI is shutting down         |

### Extension-level dispatch (VS Code -> extension handler -> CLI)

The VS Code extension has its own dispatch layer for webview messages:

| Case                            | Description                     |
| ------------------------------- | ------------------------------- |
| `get_mcp_servers`               | List all MCP servers            |
| `set_mcp_server_enabled`        | Enable/disable a server         |
| `reconnect_mcp_server`          | Reconnect a server              |
| `authenticate_mcp_server`       | Trigger OAuth flow for a server |
| `clear_mcp_server_auth`         | Clear stored auth for a server  |
| `submit_mcp_oauth_callback_url` | Complete OAuth callback         |
| `ensure_chrome_mcp_enabled`     | Enable Chrome DevTools MCP      |
| `enable_jupyter_mcp`            | Enable Jupyter MCP              |
| `disable_jupyter_mcp`           | Disable Jupyter MCP             |
| `disable_chrome_mcp`            | Disable Chrome DevTools MCP     |

## MCP Server Management

### Client states

MCP server connections have the following states:

| State        | Description                                   |
| ------------ | --------------------------------------------- |
| `connected`  | Active connection, tools available            |
| `failed`     | Connection attempt failed (has error message) |
| `disabled`   | Server disabled by user                       |
| `needs-auth` | OAuth authentication required                 |

### Reconnect flow

When `mcp_reconnect` is received by the CLI:

```
1. Look up server config by name (from config or SDK servers)
2. If not found, return error
3. Call disconnect(serverName, config):
   a. Build cache key from name + serialized config
   b. Get existing client from memoized cache
   c. If connected, call client.cleanup() (closes transport/kills process)
   d. Delete the memoized cache entry
4. Call connect(serverName, config):
   a. Create appropriate transport based on config.type:
      - stdio: spawn child process via StdioClientTransport
      - sse: SSE transport with auth provider
      - http: StreamableHTTP transport with auth
      - ws/ws-ide: WebSocket transport
      - claudeai-proxy: claude.ai proxy transport
   b. Create MCP Client instance
   c. Connect with timeout (configurable, triggers error on timeout)
   d. Return connected client with capabilities
5. Fetch tools, commands, and resources from the new connection
6. Update app state:
   a. Replace client entry in mcp.clients[]
   b. Remove old tools/commands with this server's name prefix
   c. Add new tools/commands from fresh connection
   d. Update resources map
7. Return success or error with status message
```

### Key implementation detail

The connect function (`QL` in minified code) is **memoized** - it caches
connections by a key derived from `name + JSON(config)`. The disconnect function
explicitly deletes the cache entry before reconnect creates a fresh one.

### Transport types

| Type             | Transport                       | Description                                           |
| ---------------- | ------------------------------- | ----------------------------------------------------- |
| `stdio`          | `StdioClientTransport`          | Spawns a child process, communicates via stdin/stdout |
| `sse`            | `SSEClientTransport`            | Server-Sent Events over HTTP                          |
| `http`           | `StreamableHTTPClientTransport` | Streamable HTTP (newer MCP transport)                 |
| `ws`             | Custom WebSocket transport      | WebSocket with auth headers                           |
| `ws-ide`         | Custom WebSocket transport      | WebSocket for IDE integrations                        |
| `sse-ide`        | `SSEClientTransport`            | SSE for IDE integrations                              |
| `claudeai-proxy` | `StreamableHTTPClientTransport` | Proxied through claude.ai                             |
| `sdk`            | In-process                      | Handled separately (not via transport)                |

### Implications for external tooling

**MCP server reconnect cannot be triggered from an external MCP tool.** The
reconnect operates on the CLI's in-memory state:

- It calls `.cleanup()` on the live transport object (kills subprocess / closes socket)
- It clears a memoized cache inside the CLI process
- It re-creates the connection and updates the in-memory tool registry

The only way to send a reconnect command is by writing a `control_request` JSON
line to the CLI process's stdin pipe - which requires being the parent process
that spawned it. There is no HTTP API, Unix socket, file-based signal, or other
mechanism to request a reconnect from outside. The stdin/stdout IPC protocol is
consumed exclusively by the VS Code extension (or any program using the Agent
SDK to spawn the CLI).

### Possible workarounds

1. **Agent SDK**: Use `@anthropic-ai/claude-code` as a dependency and spawn a
   Claude Code subprocess, then send `mcp_reconnect` messages via the SDK's IPC.
   This would be a separate process, not the user's running session.

2. **Config change detection**: Some MCP clients detect changes to
   `~/.claude.json` and auto-reload. This is not confirmed for Claude Code but
   could be investigated.

3. **VS Code command**: The extension registers VS Code commands. A separate
   extension could invoke these commands, but this only works in VS Code.

## Configuration

MCP servers are configured in `~/.claude.json`:

```json
{
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "node",
      "args": ["path/to/server.js"],
      "env": {"KEY": "value"}
    }
  },
  "projects": {
    "/path/to/project": {
      "mcpServers": {
        "project-scoped-server": { ... }
      }
    }
  }
}
```

Server enable/disable state is tracked separately (not in config file) via the
`mcp_toggle` IPC message and an internal `cm1(serverName)` check function.

## Related Feature Requests (as of 2026-03-18)

Programmatic MCP server control is a well-requested feature with no official
implementation timeline.

### Canonical issue

- **[#10447](https://github.com/anthropics/claude-code/issues/10447)** (open,
  43 upvotes) - "CLI Commands for MCP Server Enable/Disable (Hook Automation
  Support)". Requests `claude mcp enable/disable/toggle/status` CLI commands
  that work mid-session without restart. Primary motivation is hook integration
  (SessionStart, PreToolUse, Stop hooks) for context window optimization.

### Duplicates and related

- **[#21745](https://github.com/anthropics/claude-code/issues/21745)** (closed
  as dup of #10447, 10 upvotes) - "Programmatic API for enabling/disabling MCPs
  without restart". Confirms that editing `~/.claude.json` programmatically
  works but changes only apply after restart. Proposes CLI commands, a dedicated
  tool (`MCPEnable`/`MCPDisable`/`MCPReload`), or a FIFO-based IPC endpoint.

- **[#14067](https://github.com/anthropics/claude-code/issues/14067)** (closed
  stale, 2 upvotes) - "Expose MCP Server Toggle as a Claude-Invokable Tool for
  Skills". Specifically asks for an internal tool that Claude can call
  mid-conversation, complementary to #10447's external CLI approach.

- **[#7174](https://github.com/anthropics/claude-code/issues/7174)** (closed,
  was assigned to `ollie-anthropic`) - Bug report about `/mcp` reconnect not
  actually reloading Python modules in stdio servers.

### Community findings vs. our reverse engineering

The community independently reached the same conclusions documented here:

1. The `/mcp` TUI menu can toggle/reconnect servers without restart (the
   internal mechanism exists)
2. Editing `~/.claude.json` from a skill or hook does NOT trigger hot-reload
3. There is no programmatic way to invoke the reload mechanism

Our reverse engineering explains _why_: the reload is triggered via the
`control_request` IPC protocol on the CLI's stdin pipe, which is only accessible
to the parent process (VS Code extension or Agent SDK). In terminal mode, stdin
is the TTY (for keyboard input), not a JSON IPC channel. Child processes
(MCP servers, Bash tool commands, hooks) have no path to the CLI's stdin.

Additional blockers confirmed on macOS:

- `TIOCSTI` ioctl (keystroke injection) is disabled at the kernel level
- Debugger attach is blocked by SIP/code signing on the native binary
- AppleScript keystroke injection targets the focused app, and the CLI is busy
  executing the tool call that would send the keystrokes (deadlock)

## Config File Watching

The CLI does **not** watch `~/.claude.json` for changes. The only file watcher
in the CLI bundle is for keybindings (using chokidar). Config is read:

- **At startup** - once during initialization
- **When `/mcp` TUI is opened** - re-reads via `Xp()` in a React `useEffect`
- **On `mcp_set_servers` IPC** - the extension sends the full server list, CLI
  diffs and reconciles (connects new, disconnects removed, reconnects changed)
- **Between turns in headless/remote mode** - gated behind
  `CLAUDE_CODE_REMOTE=true` env var

The reconciliation infrastructure (`EYz` in minified code) fully supports
diffing old vs. new config: it disconnects removed/changed servers, connects
added/changed servers, and updates the tool registry. This infrastructure is
already wired up for all modes except interactive terminal.

## CLAUDE_CODE_REMOTE Environment Variable

Setting `CLAUDE_CODE_REMOTE=true` enables automatic config re-read between
turns, which would allow MCP reconnection by modifying `~/.claude.json`. However
it also changes other behaviors:

| Area                   | Effect                                                         |
| ---------------------- | -------------------------------------------------------------- |
| **MCP config refresh** | Re-reads config between turns and reconciles servers           |
| **Node.js heap**       | Sets `--max-old-space-size=8192` (8GB)                         |
| **Git system context** | Skips `git status` in system prompt (no branch/status context) |
| **Git clone URLs**     | Uses HTTPS instead of SSH for GitHub repos                     |
| **Hook progress**      | Enables streaming hook progress events                         |
| **Bash progress**      | Enables bash command progress updates                          |
| **Telemetry**          | Tags events with `isClaudeCodeRemote: true`                    |

The most impactful side effect is losing `git status` from the system prompt.

## Potential Approaches for Programmatic MCP Control

### 1. VS Code stdin/stdout proxy (most promising)

Inject a proxy between the VS Code extension and the CLI process:

```
VS Code Extension
  |  spawns (thinks it's the real CLI)
  v
Proxy Script (Node.js)
  |  spawns real CLI, forwards stdin/stdout bidirectionally
  |  logs all JSON messages
  |  listens on Unix socket for injected commands
  v
Real Claude CLI (JSON IPC mode)
```

The proxy can inject `control_request` messages (including `mcp_reconnect`)
into the CLI's stdin. Viable because VS Code mode uses structured JSON IPC.

### 2. Terminal CLI with CLAUDE_CODE_REMOTE=true

Set the env var to enable between-turn config refresh, then modify
`~/.claude.json` to trigger MCP reconnection. Trade-off: loses git status
context in system prompt.

### 3. Terminal stdin/stdout proxy (complex)

Same proxy concept but for the terminal CLI. Harder because the CLI expects
raw terminal I/O (Ink/React TUI), not JSON. Would require PTY forwarding,
and injection would be limited to simulating keystrokes (fragile).

The CLI does support `--input-format=stream-json --output-format=stream-json`
flags which switch to JSON IPC mode, but this disables the TUI entirely -
the proxy would need to reimplement a terminal UI.

## Session Data Storage

### File layout

All session data lives under `~/.claude/`:

```
~/.claude/
  projects/
    -Users-username-path-to-project/     # path-encoded project directory
      <session-uuid>.jsonl               # session transcript
      <session-uuid>/subagents/          # subagent transcripts
        agent-<id>.jsonl                 # subagent session (same format)
        agent-<id>.meta.json             # {"agentType": "general-purpose"}
      sessions-index.json                # project-level session index
  sessions/                              # active session process metadata
    <session-uuid>.json                  # {"pid", "sessionId", "cwd", "startedAt", "kind", "entrypoint"}
  session-env/                           # environment state files for session restoration
  file-history/                          # file backup snapshots
    <session-uuid>/
      <hash>@v<N>                        # versioned file backups
  history.jsonl                          # global prompt history (for --resume shell history)
  stats-cache.json                       # aggregated statistics cache
```

Project directory names are path-encoded: every `/` and `.` in the absolute
project path is replaced with `-`. For example:

- `/Users/test/project` -> `-Users-test-project`
- `/Users/test/.hidden` -> `-Users-test--hidden` (double dash for dot prefix)

### JSONL entry types

Each line in a session `.jsonl` file is a JSON object with a `type` field.

#### Core message types

| Type        | Key fields                                                  | Description                          |
| ----------- | ----------------------------------------------------------- | ------------------------------------ |
| `user`      | `message.content` (string or array of content blocks)       | User message or tool results         |
| `assistant` | `message.content` (array), `message.model`, `message.usage` | Model response with token usage      |
| `system`    | `subtype`, `durationMs`                                     | System events (e.g. `turn_duration`) |

#### Content block types (inside `message.content` arrays)

| Block type    | Parent         | Key fields               | Notes                                                    |
| ------------- | -------------- | ------------------------ | -------------------------------------------------------- |
| `text`        | assistant/user | `text`                   | Plain text content                                       |
| `thinking`    | assistant      | `thinking`, `signature`  | Extended thinking blocks                                 |
| `tool_use`    | assistant      | `name`, `id`, `input`    | Tool invocation                                          |
| `tool_result` | user           | `tool_use_id`, `content` | Tool output; `content` is string or array of text blocks |

#### Metadata entry types

| Type              | Key fields                 | Description                                      |
| ----------------- | -------------------------- | ------------------------------------------------ |
| `custom-title`    | `customTitle`, `sessionId` | User-set session title (last one wins)           |
| `ai-title`        | `aiTitle`                  | AI-generated title                               |
| `agent-name`      | `agentName`, `sessionId`   | Session name shown in status bar (last one wins) |
| `summary`         | `summary`                  | Auto-generated session summary                   |
| `last-prompt`     | `lastPrompt`, `sessionId`  | Most recent user prompt text                     |
| `permission-mode` | `permissionMode`           | Permission mode changes                          |

#### Tracking entry types

| Type                    | Key fields                                     | Description                          |
| ----------------------- | ---------------------------------------------- | ------------------------------------ |
| `file-history-snapshot` | `messageId`, `snapshot.trackedFileBackups`     | File change tracking snapshots       |
| `progress`              | `data.type`, `data.hookEvent`, `data.hookName` | Hook execution progress              |
| `attachment`            | `attachment.type`, `attachment.hookName`       | Hook results and session attachments |
| `queue-operation`       | (varies)                                       | Message queue operations             |

#### Common fields across entries

Most entry types share these top-level fields:

| Field         | Description                                            |
| ------------- | ------------------------------------------------------ |
| `uuid`        | Unique entry identifier                                |
| `parentUuid`  | Links to parent entry (for conversation tree)          |
| `timestamp`   | ISO 8601 timestamp                                     |
| `sessionId`   | Session UUID                                           |
| `type`        | Entry type discriminator                               |
| `slug`        | Session slug (three-word identifier, see naming below) |
| `cwd`         | Working directory at time of entry                     |
| `gitBranch`   | Git branch at time of entry                            |
| `version`     | CLI version string                                     |
| `userType`    | `"external"` for user-initiated                        |
| `isSidechain` | Whether this is a sidechain conversation               |

### Token usage data

Every `assistant` entry includes `message.usage`:

```json
{
    "input_tokens": 3,
    "cache_creation_input_tokens": 15357,
    "cache_read_input_tokens": 8596,
    "cache_creation": {
        "ephemeral_5m_input_tokens": 15357,
        "ephemeral_1h_input_tokens": 0
    },
    "output_tokens": 290,
    "server_tool_use": {
        "web_search_requests": 0,
        "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "inference_geo": "us",
    "speed": "standard"
}
```

The `speed` field indicates fast mode (`"fast"` vs `"standard"`). Fast mode
uses 6x pricing for Opus 4.6 ($30/$150 per MTok vs $5/$25).

Synthetic model entries (model `"<synthetic>"`) have usage objects with all
zeros and should be filtered out of cost calculations.

Model IDs may include date suffixes (e.g. `"claude-haiku-4-5-20251001"`) and
context window suffixes (e.g. `"claude-opus-4-6[1m]"` in persisted config).
Normalize by stripping `-\d{8}$` and `\[.*\]$` patterns.

### Session naming levels

Sessions have three independent naming mechanisms:

| Level            | Entry type           | Field         | Where visible                      | How set                                                       |
| ---------------- | -------------------- | ------------- | ---------------------------------- | ------------------------------------------------------------- |
| **Agent name**   | `agent-name`         | `agentName`   | Terminal status bar                | `claude --resume "name"`, or auto-generated                   |
| **Custom title** | `custom-title`       | `customTitle` | Session listings, search results   | User-set via tools, or AI titling                             |
| **Slug**         | Top-level on entries | `slug`        | Internal identifier for `--resume` | Auto-generated by CLI (three-word: adjective-participle-noun) |

Additionally, `ai-title` and `summary` entries provide auto-generated descriptions.

For custom titles and agent names, the **last entry wins** - new values are
appended to the end of the JSONL file. For slugs, the value is stored on
every entry and must be rewritten across all entries to change it.

Priority for display: `customTitle > aiTitle > summary > firstPrompt[:60]`.

Most sessions (especially older ones) may not have an `agent-name` entry.
The slug field may also be absent on entries from older CLI versions.

### Persisted session stats in ~/.claude.json

The CLI persists session statistics in `~/.claude.json` under the project's
config key. This is written on session exit via `saveCurrentSessionCosts()` in
`src/cost-tracker.ts` and restored on resume via `restoreCostStateForSession()`.

```json
{
    "projects": {
        "/absolute/path/to/project": {
            "lastSessionId": "688ba098-930b-4ee9-b3ec-f871a053d9b4",
            "lastCost": 32.95,
            "lastAPIDuration": 2353774,
            "lastAPIDurationWithoutRetries": 2353774,
            "lastToolDuration": 0,
            "lastDuration": 7859556,
            "lastLinesAdded": 2729,
            "lastLinesRemoved": 884,
            "lastTotalInputTokens": 15282,
            "lastTotalOutputTokens": 94695,
            "lastTotalCacheCreationInputTokens": 1295719,
            "lastTotalCacheReadInputTokens": 49446876,
            "lastTotalWebSearchRequests": 0,
            "lastFpsAverage": 29.5,
            "lastFpsLow1Pct": 12.3,
            "lastModelUsage": {
                "claude-opus-4-6[1m]": {
                    "inputTokens": 409,
                    "outputTokens": 85631,
                    "cacheReadInputTokens": 47690052,
                    "cacheCreationInputTokens": 1021807,
                    "webSearchRequests": 0,
                    "costUSD": 32.37
                }
            }
        }
    }
}
```

Key points:

- **Keyed by `lastSessionId`**: Only the most recent session's stats are kept
  per project. If a different session runs in the same project, the previous
  session's data is overwritten.
- **Code changes (linesAdded/linesRemoved)**: Tracked in-memory by
  `FileWriteTool` via `countLinesChanged()` in `src/utils/diff.ts`, which
  counts `+`/`-` lines in structured patches. Not stored in the JSONL.
- **Model names include context window suffixes**: e.g.
  `"claude-opus-4-6[1m]"`. Strip `\[.*\]$` when normalizing.
- **Snapshot vs. JSONL totals**: The persisted cost reflects the state at
  last exit. If the session is resumed, the JSONL accumulates more entries,
  so JSONL-based calculations may show higher totals.
- **Duration fields**: `lastAPIDuration` is cumulative API call time in ms.
  `lastDuration` is wall clock time in ms. `lastToolDuration` is time spent
  in tool execution.

### Cost calculation

Cost is calculated in `src/utils/modelCost.ts` using per-model pricing tiers:

| Tier        | Models                  | Input/MTok | Output/MTok | Cache Write | Cache Read |
| ----------- | ----------------------- | ---------- | ----------- | ----------- | ---------- |
| $5/$25      | Opus 4.5, 4.6           | $5         | $25         | $6.25       | $0.50      |
| $15/$75     | Opus 4, 4.1             | $15        | $75         | $18.75      | $1.50      |
| $3/$15      | Sonnet 3.7, 4, 4.5, 4.6 | $3         | $15         | $3.75       | $0.30      |
| $1/$5       | Haiku 4.5               | $1         | $5          | $1.25       | $0.10      |
| $0.80/$4    | Haiku 3.5               | $0.80      | $4          | $1.00       | $0.08      |
| $0.25/$1.25 | Haiku 3                 | $0.25      | $1.25       | $0.30       | $0.03      |

Cache write = 1.25x base input (5-minute ephemeral cache).
Cache read = 0.1x base input.
Web search = $0.01 per request.
Fast mode (Opus 4.6) = 6x standard pricing ($30/$150 per MTok).

### Exit stats display

The formatted stats shown on session exit are generated by `formatTotalCost()`
in `src/cost-tracker.ts`:

```
Total cost:            $29.64
Total duration (API):  37m 5s
Total duration (wall): 2h 0m 8s
Total code changes:    2722 lines added, 883 lines removed
Usage by model:
     claude-opus-4-6:  383 input, 83.0k output, 44.2m cache read, 782.1k cache write ($29.07)
    claude-haiku-4-5:  14.9k input, 9.1k output, 1.8m cache read, 273.9k cache write ($0.58)
```

Token counts use compact notation via `formatNumber()`: e.g. 1200 -> "1.2k",
900 -> "900". Model names are normalized to canonical short names via
`getCanonicalName()`. Web search requests are only shown per model if > 0.

### sessions-index.json

Each project directory may contain a `sessions-index.json` with pre-computed
metadata:

```json
{
    "version": 1,
    "entries": [
        {
            "sessionId": "78afb69c-...",
            "fullPath": "/Users/.../.claude/projects/.../78afb69c-....jsonl",
            "fileMtime": 1768232669462,
            "firstPrompt": "take look at linear ticket...",
            "summary": "integrate-visits-parser-etl",
            "messageCount": 142,
            "created": "2026-04-05T12:41:27.358Z",
            "modified": "2026-04-05T15:09:24.575Z",
            "gitBranch": "main",
            "projectPath": "/Users/.../project",
            "isSidechain": false
        }
    ],
    "originalPath": "/Users/username"
}
```

This index does NOT contain slug or agent-name information - those must be
read from the JSONL files directly.

### history.jsonl

The global `~/.claude/history.jsonl` records shell prompt history for the
`--resume` feature. It is separate from session transcripts:

```json
{
    "display": "fix the login bug",
    "pastedContents": {},
    "timestamp": 1759048473666,
    "project": "/Users/username/project"
}
```
