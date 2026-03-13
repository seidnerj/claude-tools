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

As a library dependency:

```bash
npm install claude-tools
```

For development:

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

Symlink the CLI tools to your PATH:

```bash
BIN_DIR="$(pwd)/src/bin"
sudo ln -sf "$BIN_DIR/claude-find-session.ts" /usr/local/bin/claude-find-session
sudo ln -sf "$BIN_DIR/claude-redact-secrets.ts" /usr/local/bin/claude-redact-secrets
sudo ln -sf "$BIN_DIR/claude-set-history.ts" /usr/local/bin/claude-set-history
sudo ln -sf "$BIN_DIR/claude-set-key.ts" /usr/local/bin/claude-set-key
sudo ln -sf "$BIN_DIR/claude-title-sessions.ts" /usr/local/bin/claude-title-sessions
```

### LLM Safety Hook Setup

The safety hook is a `PreToolUse` hook for Claude Code that sends Bash commands to Claude (with extended thinking) for safety evaluation.

```bash
sudo ln -sf "$(pwd)/src/bin/llm-safety-check.ts" /usr/local/bin/llm-safety-check
```

Add to `~/.claude/settings.json`:

```json
{
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "Bash",
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

## Library API

All modules are re-exported from the package entry point:

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

## License

MIT
