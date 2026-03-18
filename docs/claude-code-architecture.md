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
- `webview/` - Webview UI assets

**Architecture**: The extension bundles the Claude Agent SDK and uses it to spawn
a CLI subprocess. It detects which form to use by checking the file extension -
if the path ends in `.js`/`.mjs`/`.tsx`/`.ts`/`.jsx` it runs via Node.js;
otherwise it spawns the native binary directly. All conversation state, tool
execution, and MCP management happens in the CLI process. The extension handles:

- VS Code integration (status bar, webview panels, commands)
- Process lifecycle (spawn, kill, reconnect)
- UI rendering for MCP server management, auth flows, etc.

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
