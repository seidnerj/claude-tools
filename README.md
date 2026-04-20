# claude-tools

TypeScript library for managing [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions, API keys, secrets, and history.

Used as a dependency by [claude-tools-mcp](https://github.com/seidnerj/claude-tools-mcp), which exposes these features as MCP tools for Claude Code.

## Features

- **Session search** - Text and LLM-powered semantic search across conversation history
- **Session titling** - Generate AI titles for untitled sessions using the Claude API
- **Secret scanning** - Detect and redact leaked secrets in session files (uses [detect-secrets](https://github.com/Yelp/detect-secrets))
- **API key management** - Store, retrieve, and manage per-directory Anthropic API keys in macOS Keychain, with `.envrc` integration for [direnv](https://direnv.net/)
- **History management** - Move conversation history when renaming/moving project directories, clean broken resume artifacts
- **LLM safety hook** - `PreToolUse` hook that evaluates Bash commands for safety before execution (approve/deny/prompt)

## Installation

```bash
git clone https://github.com/seidnerj/claude-tools.git
cd claude-tools
npm install
```

## CLI Tools

All CLI tools require `tsx` installed globally (`npm install -g tsx`). Each tool has a `--help` flag.

| Command                 | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `claude-find-session`   | Search session history by text or LLM semantic search   |
| `claude-title-sessions` | Generate AI titles for untitled sessions                |
| `claude-redact-secrets` | Scan for and redact leaked secrets in session files     |
| `claude-set-key`        | Manage per-directory API keys in macOS Keychain         |
| `claude-set-history`    | Move conversation history when renaming/moving projects |
| `llm-safety-check`      | PreToolUse hook that evaluates Bash commands for safety |

### Installation

Via `npm link` (no `tsx` needed):

```bash
npm link
```

Or from a cloned repo (requires `tsx`):

```bash
BIN_DIR="$(pwd)/src/bin"
sudo ln -sf "$BIN_DIR/claude-find-session.ts" /usr/local/bin/claude-find-session
sudo ln -sf "$BIN_DIR/claude-redact-secrets.ts" /usr/local/bin/claude-redact-secrets
sudo ln -sf "$BIN_DIR/claude-set-history.ts" /usr/local/bin/claude-set-history
sudo ln -sf "$BIN_DIR/claude-set-key.ts" /usr/local/bin/claude-set-key
sudo ln -sf "$BIN_DIR/claude-title-sessions.ts" /usr/local/bin/claude-title-sessions
```

### LLM Safety Hook Setup

The safety hook is a `PreToolUse` hook for Claude Code that evaluates tool actions for safety before execution. It covers Bash commands, file edits/writes, network requests, sub-agent spawning, and MCP tool calls.

```bash
sudo ln -sf "$(pwd)/src/bin/llm-safety-check.ts" /usr/local/bin/llm-safety-check
```

Add to `~/.claude/settings.json`:

```json
{
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "Bash|Edit|Write|WebFetch|WebSearch|Agent|NotebookEdit|mcp__.*",
                "hooks": [
                    {
                        "type": "command",
                        "command": "llm-safety-check",
                        "timeout": 35
                    }
                ]
            }
        ]
    }
}
```

Requires `ANTHROPIC_API_KEY` env var or a key stored in macOS Keychain under "Claude Code".

**Configuration** (optional, in `~/.claude/key-config.json`):

```json
{
    "safety": {
        "model": "claude-sonnet-4-6",
        "context_level": "user-only"
    }
}
```

- `model` - classifier model (default: `claude-sonnet-4-6`, matching Auto Mode)
- `context_level` - transcript context sent to classifier:
    - `"none"` - no transcript access (maximum isolation)
    - `"user-only"` (default) - user messages + tool call names (no assistant text or tool results)
    - `"full"` - all message types except raw tool results

### LLM Safety Hook vs. Claude Code Auto Mode

Claude Code's [Auto Mode](https://docs.anthropic.com/en/docs/claude-code/security#auto-mode) (March 2025) provides built-in automated permission handling with its own safety classifier. The table below compares it with this project's LLM safety hook.

#### Architecture

|                                    | LLM Safety Hook                                                                                                                   | Auto Mode                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **How it works**                   | `PreToolUse` hook that sends each tool action to a separate LLM call (Sonnet 4.6 default) with a dedicated security system prompt | Built-in classifier (Sonnet 4.6) that evaluates tool calls against the user's original request and task context     |
| **Scope**                          | All tool types: Bash, Edit, Write, WebFetch, WebSearch, Agent, MCP tools                                                          | All tool types (Bash, file edits, MCP tools, etc.)                                                                  |
| **Context provided to classifier** | Tool input + CLAUDE.md + configurable transcript context (none/user-only/full). Two-pass file inspection for Bash.                | User messages and tool calls, with Claude's own text and tool results stripped out. Also receives CLAUDE.md content |
| **Decisions**                      | Approve, deny (hard block), or prompt (fall back to user). Graceful degradation after 3 consecutive or 20 total blocks.           | Auto-approve, block (Claude retries with alternative approach), or escalate to user after repeated blocks           |
| **Customization**                  | Configurable model, context level, editable system prompt with BLOCK/ALLOW categories                                             | Configurable allow/deny rules and `autoMode.environment` trusted infrastructure settings                            |

#### Availability

|                        | LLM Safety Hook                                  | Auto Mode                                                                                                            |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Plan requirements**  | Any - works with any Anthropic API key           | Team plan required (Enterprise and API access rolling out)                                                           |
| **Model requirements** | Any model with API access (defaults to Opus 4.6) | Sonnet 4.6 or Opus 4.6 only; not available on Haiku, Claude 3.x, or third-party providers (Bedrock, Vertex, Foundry) |
| **Setup**              | Manual hook configuration in `settings.json`     | `claude --permission-mode auto` or `--enable-auto-mode` flag                                                         |

#### Pros and Cons

**LLM Safety Hook**

- Works with API keys on any plan
- Configurable context isolation (none/user-only/full) - at "none" level, classifier has zero visibility into the conversation
- Hard deny capability - blocked commands cannot be retried or worked around
- Two-pass file inspection - classifier can request file contents before deciding (unique to this hook)
- Fully customizable system prompt, model, and evaluation logic
- Fast-path for known-safe commands and local file edits (no API call)
- Graceful degradation (3 consecutive or 20 total blocks -> falls back to user prompt)
- Adds latency and API cost to non-fast-pathed tool calls

**Auto Mode**

- Built-in with no extra configuration beyond a flag
- Has richer task context - sees the full conversation transcript (minus tool results)
- Falls back gracefully (pauses auto mode after repeated blocks)
- Requires Team/Enterprise plan - not available with standalone API keys
- Classifier sees partial conversation context, which could be influenced by prompt injection
- No two-pass file inspection capability

#### Using Both Together

`PreToolUse` hooks fire regardless of the permission mode, so both can run simultaneously. When combined, the safety hook acts as a defense-in-depth layer - Auto Mode handles broad permission management, while the hook provides an independent safety check with its own classifier, BLOCK/ALLOW rules, and two-pass file inspection.

## Library API

All modules are re-exported from the package entry point. If using `npm link`, import by package name; otherwise use a relative path:

```typescript
import {
    // Session search
    searchProject,
    searchAllProjects,
    llmSearch,
    llmSearchAll,
    // Session titling
    titleProject,
    titleAllProjects,
    // Secret scanning
    scanProject,
    scanAllProjects,
    // History management
    moveHistory,
    cleanBrokenResumeArtifacts,
    // API key management (macOS Keychain)
    getKey,
    storeKey,
    deleteKey,
    copyKey,
    listKeychainEntries,
    // Safety hook
    checkCommandSafety,
} from "claude-tools";
```

## Requirements

- Node.js >= 20
- macOS (for Keychain-based API key management)
- `detect-secrets` (`pip install detect-secrets`) for secret scanning
- `tsx` installed globally for the safety hook
- An Anthropic API key for LLM-powered features (search, titling, safety hook)

## Development

```bash
npm install
npm test              # Run tests (vitest)
npm run test:watch    # Watch mode
npm run lint          # Type check
npm run build         # Compile TypeScript
```

## Disclaimer

Claude and Claude Code are trademarks of Anthropic, PBC. This project is not affiliated with, endorsed by, or sponsored by Anthropic.

## License

MIT © 2026 seidnerj

This software is provided "as is" without warranty of any kind. See [LICENSE](LICENSE) for full terms.
