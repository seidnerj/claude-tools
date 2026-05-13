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
        "model": "claude-opus-4-6",
        "context_level": "user-only",
        "classifier_mode": "two-stage",
        "single_stage_variant": "thinking",
        "fail_closed": false,
        "user_rules": {
            "block_rules": ["No production deploys without ticket"],
            "allow_rules": ["Reading from /opt/internal-docs"],
            "environment": ["repo: github.com/org/proj", "internal API: api.corp.example"]
        }
    }
}
```

- `model` - classifier model (default: `claude-opus-4-6`)
- `context_level` - transcript context sent to classifier:
    - `"none"` - no transcript access (maximum isolation)
    - `"user-only"` (default) - user messages only (no assistant text or tool calls)
    - `"full"` - user + assistant text + prior tool_use blocks (read-only tools filtered)
    - `"auto"` - evaluate at `user-only` first; if the final verdict is `prompt`, re-run the full S1+S2 flow at `full` (rerunning S1 with the richer context; resolved files are cached across passes so disk I/O happens at most once per file per decision). Approve/deny short-circuits without escalation. Cache entries are keyed on the context level the decision was made at, so a `user-only` approve does not satisfy a later `full` lookup.
- `classifier_mode` (default `"two-stage"`) - `"two-stage"` runs a 64-token strict S1 gate then escalates ambiguous actions to a full S2 evaluation; `"single-stage"` runs one classifier call per action.
- `single_stage_variant` (default `"thinking"`) - only used when `classifier_mode: "single-stage"`. `"thinking"` is JSON output with extended thinking enabled; `"fast"` is a 256-token XML verdict (`<block>yes/no</block>`) with stop-sequence truncation for minimum latency.
- `fail_closed` (default `false`) - `true` denies the action when the classifier API is unavailable (for unattended/CI runs); `false` falls through to the standard CC permission prompt (the default, fail-open).
- `user_rules` - extend the built-in BLOCK / ALLOW lists with project-specific rules and declare a trusted environment (repos, internal hosts, buckets) without editing the system prompt:
    - `block_rules` - additional BLOCK conditions appended to the system prompt
    - `allow_rules` - additional ALLOW exceptions appended to the system prompt
    - `environment` - trusted infrastructure listed in the prompt's environment section
- `debug_log` - if set, every safety decision appends one JSONL line with the full classifier chain (per-stage records, context level used, model, usage, files requested/resolved, final verdict, cache_hit). The value is interpreted as follows:
    - Path exists and is a directory -> daily file `safety-YYYY-MM-DD.jsonl` is appended inside it
    - Path exists and is a file -> log lines are appended to that file
    - Path does not exist and the basename has a dot (e.g. `/var/log/safety.jsonl`) -> file path, created on first write
    - Path does not exist and the basename has no dot (e.g. `/tmp/claude-safety`) -> directory, created on first write, daily file inside
    - Unset/empty disables logging.

#### Suggested CLAUDE.md directives

Some legitimate actions trigger prompts because of how they're _shaped_, not because of what they actually do. Adding the following section to your global `~/.claude/CLAUDE.md` (or to a project's `CLAUDE.md`) guides Claude to frame legitimate work in ways the classifier can recognize, cutting down false-positive prompts without weakening the safety posture:

```md
## Avoiding False-Positive Safety Prompts

A local LLM safety hook reviews tool calls before execution. Routine legitimate actions sometimes prompt because of how they're shaped, not because of what they actually do. Frame legitimate work so the classifier can recognize it:

- **Prefer dedicated tools over Bash:** Use Read/Edit/Write instead of cat/sed/echo. These fast-approve when the path is inside the working directory; the Bash equivalents do not.
- **Compound `cd X && cmd` frequently triggers built-in safety prompts**, even when otherwise innocuous. Use absolute paths in both the command and any redirect target, or run `cd` separately.
- **Chain within a risk class, split across:** `git fetch && git rebase && npm test` is fine - homogeneous dev-loop operations. Mixing reads with writes, or local with remote side-effects, in one chain makes scope evaluation harder. Independent operations can run as separate Bash calls in a single message (they execute in parallel, so splitting costs no extra turns).
- **Avoid shell expansion of opaque values:** Don't compose commands via `$(cat ... | python3 -c ...)` or `"$VAR"` from arbitrary sources interpolated into longer commands. Read values directly inside the target script.
- **Persistent capability changes need explicit, specific user intent:** Commands like `claude mcp add`, `~/.claude/*.json` edits, shell profile edits, cron, launchctl get extra scrutiny. They can auto-approve when the user explicitly asked for that exact change, but prompt when the agent inferred the need mid-task or when the request was vague. Execute when the user spelled it out; otherwise propose the exact command instead of running it.
- **Honest descriptions echo the user's verb:** The Bash `description` field is visible to the classifier and to the user. For destructive actions, use the user's word (delete/remove/drop/overwrite) so the user-intent ALLOW path can apply.
- **Avoid sourcing-from-internet and exfil shapes:** No `curl ... | sh`, no `gh gist create` of unsolicited content, no `nc`/`scp` to non-project hosts. These are unambiguous BLOCK patterns.
```

### LLM Safety Hook vs. Claude Code Auto Mode

Claude Code's [Auto Mode](https://docs.anthropic.com/en/docs/claude-code/security#auto-mode) (March 2025) provides built-in automated permission handling with its own safety classifier. The table below compares it with this project's LLM safety hook.

#### Architecture

|                                    | LLM Safety Hook                                                                                                                                                                              | Auto Mode                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **How it works**                   | `PreToolUse` hook with two-stage classifier (default): 64-tok strict S1 gate, then 4096-tok S2 with extended thinking on escalate. Single-stage mode (fast or thinking) available via config | Built-in two-stage classifier (Sonnet/Opus 4.6) - same staging pattern, controlled by GrowthBook feature flag |
| **Scope**                          | All tool types: Bash, Edit, Write, WebFetch, WebSearch, Agent, MCP tools                                                                                                                     | All tool types (Bash, file edits, MCP tools, etc.)                                                            |
| **Context provided to classifier** | Tool input + CLAUDE.md + configurable transcript (none/user-only/full, with prior tool_use blocks at "full"). Two-pass `needs_context` file inspection (unique to this hook)                 | User text + prior tool_use blocks (read-only filtered) + CLAUDE.md. Fixed context shape, no isolation knob    |
| **Cost optimization**              | 1h ephemeral prompt cache on system + CLAUDE.md + action blocks; in-session approval cache; per-tool input redaction registry; fast-path regex allowlist for routine read-only commands      | 1h ephemeral prompt cache; approval cache; per-tool input redaction                                           |
| **Decisions**                      | Approve, deny (hard block), or prompt (fall back to user). Graceful degradation after 3 consecutive or 20 total denies                                                                       | Auto-approve, block (Claude retries with alternative approach), or escalate to user after repeated blocks     |
| **Failure mode**                   | Configurable: `fail_closed: false` (default, falls through to user prompt) or `fail_closed: true` (denies on classifier failure for CI/unattended)                                           | Fail-closed - blocks on classifier unavailable                                                                |
| **Customization**                  | Configurable model, context level, classifier mode, fail-closed, user-supplied BLOCK/ALLOW/environment rules via placeholder substitution; editable system prompt as a final escape hatch    | Configurable allow/deny rules and `autoMode.environment` trusted infrastructure settings                      |

#### Availability

|                        | LLM Safety Hook                                  | Auto Mode                                                                                                            |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Plan requirements**  | Any - works with any Anthropic API key           | Team plan required (Enterprise and API access rolling out)                                                           |
| **Model requirements** | Any model with API access (defaults to Opus 4.6) | Sonnet 4.6 or Opus 4.6 only; not available on Haiku, Claude 3.x, or third-party providers (Bedrock, Vertex, Foundry) |
| **Setup**              | Manual hook configuration in `settings.json`     | `claude --permission-mode auto` or `--enable-auto-mode` flag                                                         |

#### Pros and Cons

**LLM Safety Hook**

- Works with API keys on any plan
- Two-stage classifier (default) with strict S1 gate + 1h ephemeral prompt cache - matches Auto Mode's effective steady-state cost profile
- In-session approval cache - repeated identical actions skip the API call entirely
- Per-tool input redaction registry - read-only tools (Read, Grep, Glob, etc.) skip classification entirely; per-tool default formatters for the rest
- User-customizable BLOCK / ALLOW / environment rules via `safety.user_rules` config (no need to edit the system prompt source)
- Configurable context isolation (none/user-only/full); at "none" the classifier sees only the action itself
- Configurable fail-closed mode for CI / unattended runs
- Hard deny capability - blocked commands cannot be retried or worked around
- Two-pass `needs_context` file inspection - classifier can request file contents before deciding (unique to this hook)
- Fast-path regex allowlist for routine read-only Bash commands (no API call)
- Graceful degradation (3 consecutive / 20 total denies -> falls back to user prompt)
- Adds latency and API cost to non-fast-pathed tool calls (mitigated significantly by caching + S1 gate)

**Auto Mode**

- Built-in with no extra configuration beyond a flag
- Has richer task context - sees the full conversation transcript (minus tool results)
- Falls back gracefully (pauses auto mode after repeated blocks)
- Requires Team/Enterprise plan - not available with standalone API keys
- Classifier sees partial conversation context, which could be influenced by prompt injection
- No two-pass file inspection capability

#### Using Both Together

`PreToolUse` hooks fire regardless of the permission mode, so both can run simultaneously. The hook fires first; if it allows or denies, Auto Mode is short-circuited. If the hook returns `null` (prompt / API failure / degradation), Auto Mode then evaluates. When combined, the safety hook acts as a defense-in-depth layer - Auto Mode handles broad permission management, while the hook provides an independent safety check with its own classifier, hard-deny capability, `needs_context` file inspection, and customizable rules.

For deeper technical detail on Auto Mode's internals (system prompt structure, S1/S2 staging, GrowthBook control, output formats, function names for re-verification), see [`docs/auto-mode-research.md`](docs/auto-mode-research.md).

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
