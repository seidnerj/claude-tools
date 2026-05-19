// ---------------------------------------------------------------------------
// direnv envrc management: central script at ~/.claude-tools/envrc.sh,
// per-directory .envrc source lines, and the shell snippet itself.
//
// Resolution order on every directory entry:
//   1. Inference chain: ~/.claude-tools/directories.json maps base64(PWD)
//      to a chain-id; ~/.claude-tools/chains/<chain-id>.json is the chain
//      config. When found, exports _CLAUDE_INFERENCE_CONFIG to that path so
//      a compatible Claude Code build picks it up.
//   2. Per-directory keychain entries (fallback): "Claude Code <base64-PWD>"
//      holds an API key, ":admin" suffix holds an admin session key. When
//      found, exports ANTHROPIC_API_KEY and ANTHROPIC_API_PLAN_ADMIN_SESSION_KEY
//      so any consumer (including stock Claude Code) can pick them up.
//
// No spend-banner network calls. No key validity ping. Either mode prints a
// one-line banner with the active source.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CLAUDE_TOOLS_DIR = path.join(os.homedir(), ".claude-tools");
export const CENTRAL_ENVRC_PATH = path.join(CLAUDE_TOOLS_DIR, "envrc.sh");
export const ENVRC_SOURCE_LINE = `. "$HOME/.claude-tools/envrc.sh"`;

export const ENVRC_SNIPPET = `# managed by claude-tools
_CC_PWDB64=$(echo -n "$PWD" | base64)
_CC_CHAIN_ID=$(python3 -c 'import json,os,sys; p=os.path.expanduser("~/.claude-tools/directories.json"); d=json.load(open(p)) if os.path.exists(p) else {}; print(d.get(sys.argv[1],""))' "$_CC_PWDB64" 2>/dev/null)
if [ -n "$_CC_CHAIN_ID" ] && [ -f "$HOME/.claude-tools/chains/$_CC_CHAIN_ID.json" ]; then
  export _CLAUDE_INFERENCE_CONFIG="$HOME/.claude-tools/chains/$_CC_CHAIN_ID.json"
  _CC_CHAIN_NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("name", sys.argv[2]))' "$_CLAUDE_INFERENCE_CONFIG" "$_CC_CHAIN_ID" 2>/dev/null)
  printf '\\033[36mdirenv: inference chain: %s\\033[0m\\n' "\${_CC_CHAIN_NAME:-$_CC_CHAIN_ID}" >&2
  unset _CC_CHAIN_NAME
else
  _CC_KEY=$(security find-generic-password -s "Claude Code $_CC_PWDB64" -w 2>/dev/null)
  if [ -n "$_CC_KEY" ]; then
    _cc_label() {
      local _h _n
      _h=$(echo -n "$1" | shasum -a 256 | cut -c1-16)
      _n=$(grep -o "\\"\${_h}\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\"" ~/.claude/key-config.json 2>/dev/null | sed 's/.*:[[:space:]]*"//' | sed 's/"$//')
      if [ -n "$_n" ]; then echo "$_n"; else echo "\${1:0:12}...\${1: -4}"; fi
    }
    if [ -n "$ANTHROPIC_API_KEY" ] && [ "$ANTHROPIC_API_KEY" != "$_CC_KEY" ]; then
      printf '\\033[33mdirenv: overriding API key: %s -> %s\\033[0m\\n' "$(_cc_label "$ANTHROPIC_API_KEY")" "$(_cc_label "$_CC_KEY")" >&2
    else
      printf '\\033[36mdirenv: using API key: %s\\033[0m\\n' "$(_cc_label "$_CC_KEY")" >&2
    fi
    export ANTHROPIC_API_KEY="$_CC_KEY"
    _CC_ADMIN=$(security find-generic-password -s "Claude Code $_CC_PWDB64:admin" -w 2>/dev/null)
    if [ -n "$_CC_ADMIN" ]; then
      export ANTHROPIC_API_PLAN_ADMIN_SESSION_KEY="$_CC_ADMIN"
    fi
    unset _CC_ADMIN _CC_KEY
    unset -f _cc_label 2>/dev/null
  fi
fi
unset _CC_PWDB64 _CC_CHAIN_ID`;

function ensureCentralEnvrc(): void {
    if (!fs.existsSync(CLAUDE_TOOLS_DIR)) {
        fs.mkdirSync(CLAUDE_TOOLS_DIR, { recursive: true });
    }
    const desired = ENVRC_SNIPPET + "\n";
    if (!fs.existsSync(CENTRAL_ENVRC_PATH) || fs.readFileSync(CENTRAL_ENVRC_PATH, "utf-8") !== desired) {
        fs.writeFileSync(CENTRAL_ENVRC_PATH, desired);
    }
}

export function ensureEnvrc(directory: string): { created: boolean; appended: boolean; alreadyPresent: boolean } {
    ensureCentralEnvrc();
    const envrc = path.join(directory, ".envrc");

    if (!fs.existsSync(envrc)) {
        fs.writeFileSync(envrc, ENVRC_SOURCE_LINE + "\n");
        return { created: true, appended: false, alreadyPresent: false };
    }

    const content = fs.readFileSync(envrc, "utf-8");
    if (content.includes(ENVRC_SOURCE_LINE)) {
        return { created: false, appended: false, alreadyPresent: true };
    }

    const sep = content.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(envrc, sep + ENVRC_SOURCE_LINE + "\n");
    return { created: false, appended: true, alreadyPresent: false };
}

export function removeEnvrcSnippet(directory: string): { removed: boolean; fileDeleted: boolean } {
    const envrc = path.join(directory, ".envrc");
    if (!fs.existsSync(envrc)) return { removed: false, fileDeleted: false };

    const content = fs.readFileSync(envrc, "utf-8");
    if (!content.includes(ENVRC_SOURCE_LINE)) return { removed: false, fileDeleted: false };

    const cleaned = content
        .replace(new RegExp(`^${ENVRC_SOURCE_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "m"), "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    if (!cleaned) {
        fs.unlinkSync(envrc);
        return { removed: true, fileDeleted: true };
    }

    fs.writeFileSync(envrc, cleaned + "\n");
    return { removed: true, fileDeleted: false };
}
