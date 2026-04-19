// ---------------------------------------------------------------------------
// Manage per-directory Anthropic API keys in macOS Keychain
// ---------------------------------------------------------------------------

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { CapturedKeyEntry, KeychainEntry, KeychainListResult, KeyValidationResult } from "./types.js";
import { getConfigFile, ensureConfig, configGet, configSet } from "./utils.js";

const ENVRC_SNIPPET = `# managed by claude-tools
_CC_KEY=$(security find-generic-password -s "Claude Code $(echo -n "$PWD" | base64)" -w 2>/dev/null)
if [ -n "$_CC_KEY" ]; then
  _cc_resolve_name() {
    local _h _n
    _h=$(echo -n "$1" | shasum -a 256 | cut -c1-16)
    _n=$(grep -o "\\"\${_h}\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\"" ~/.claude/key-config.json 2>/dev/null | sed 's/.*:[[:space:]]*"//' | sed 's/"$//')
    if [ -n "$_n" ]; then echo "$_n"; else echo "\${1:0:12}...\${1: -4}"; fi
  }
  if [ -n "$ANTHROPIC_API_KEY" ] && [ "$ANTHROPIC_API_KEY" = "$_CC_KEY" ]; then
    printf '\\033[36mdirenv: using API key: %s\\033[0m\\n' "$(_cc_resolve_name "$_CC_KEY")" >&2
  elif [ -n "$ANTHROPIC_API_KEY" ]; then
    printf '\\033[33mdirenv: overriding API key: %s -> %s\\033[0m\\n' "$(_cc_resolve_name "$ANTHROPIC_API_KEY")" "$(_cc_resolve_name "$_CC_KEY")" >&2
    export ANTHROPIC_API_KEY="$_CC_KEY"
  else
    export ANTHROPIC_API_KEY="$_CC_KEY"
    printf '\\033[36mdirenv: using API key: %s\\033[0m\\n' "$(_cc_resolve_name "$_CC_KEY")" >&2
  fi
  _CC_SHELL_PID=$(ps -o ppid= -p $PPID 2>/dev/null | tr -d ' ')
  (
    _CC_RESP=$(curl -s https://api.anthropic.com/v1/messages/count_tokens \\
      -H "x-api-key: $_CC_KEY" -H "anthropic-version: 2023-06-01" \\
      -H "content-type: application/json" \\
      -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"a"}]}')
    case "$_CC_RESP" in
      *'"input_tokens"'*) ;;
      *"usage limits"*)   printf '\\n\\033[33mdirenv: warning: API key quota exhausted\\033[0m\\n' > /dev/tty; [ -f "/tmp/.claude-tools-usr1-$_CC_SHELL_PID" ] && kill -USR1 $_CC_SHELL_PID 2>/dev/null ;;
      *)                  printf '\\n\\033[33mdirenv: warning: API key is invalid\\033[0m\\n' > /dev/tty; [ -f "/tmp/.claude-tools-usr1-$_CC_SHELL_PID" ] && kill -USR1 $_CC_SHELL_PID 2>/dev/null ;;
    esac
  ) </dev/null &>/dev/null 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &
  _CC_ADMIN=$(security find-generic-password -s "Claude Code $(echo -n "$PWD" | base64):admin" -w 2>/dev/null)
  case "$_CC_ADMIN" in
    *:*)
      _CC_ORG="\${_CC_ADMIN%%:*}"
      _CC_SK="\${_CC_ADMIN#*:}"
      export ANTHROPIC_ORG_ID="$_CC_ORG"
      export ANTHROPIC_ADMIN_SESSION_KEY="$_CC_SK"
      ;;
    *)
      _CC_ORG="\${ANTHROPIC_ORG_ID:-}"
      _CC_SK="\${ANTHROPIC_ADMIN_SESSION_KEY:-}"
      ;;
  esac
  if [ -n "$_CC_SK" ] && [ -n "$_CC_ORG" ]; then
    _CC_META=$(security find-generic-password -s "Claude Code $(echo -n "$PWD" | base64):meta" -w 2>/dev/null)
    case "$_CC_META" in
      *:*) _CC_KEY_ID="\${_CC_META%%:*}" _CC_WS_ID="\${_CC_META##*:}" ;;
      *)   _CC_KEY_ID="" _CC_WS_ID="" ;;
    esac
    (
      _CC_TMP1=$(mktemp) _CC_TMP2=$(mktemp) _CC_TMP3=$(mktemp) _CC_TMP4=$(mktemp) _CC_TMP5=$(mktemp) _CC_TMP6=$(mktemp)
      curl -s "https://platform.claude.com/api/organizations/$_CC_ORG/current_spend" \\
        -H "Cookie: sessionKey=$_CC_SK" \\
        -H "Content-Type: application/json" \\
        -H "anthropic-client-platform: web_console" > "$_CC_TMP1" 2>/dev/null &
      curl -s "https://platform.claude.com/api/organizations/$_CC_ORG/spend_limits_v2" \\
        -H "Cookie: sessionKey=$_CC_SK" \\
        -H "Content-Type: application/json" \\
        -H "anthropic-client-platform: web_console" > "$_CC_TMP5" 2>/dev/null &
      curl -s "https://platform.claude.com/api/organizations/$_CC_ORG" \\
        -H "Cookie: sessionKey=$_CC_SK" \\
        -H "Content-Type: application/json" \\
        -H "anthropic-client-platform: web_console" > "$_CC_TMP6" 2>/dev/null &
      if [ -n "$_CC_WS_ID" ]; then
        curl -s "https://platform.claude.com/api/organizations/$_CC_ORG/workspaces/$_CC_WS_ID/current_spend" \\
          -H "Cookie: sessionKey=$_CC_SK" \\
          -H "Content-Type: application/json" \\
          -H "anthropic-client-platform: web_console" > "$_CC_TMP2" 2>/dev/null &
        curl -s "https://platform.claude.com/api/organizations/$_CC_ORG/workspaces/$_CC_WS_ID/spend_limits_v2" \\
          -H "Cookie: sessionKey=$_CC_SK" \\
          -H "Content-Type: application/json" \\
          -H "anthropic-client-platform: web_console" > "$_CC_TMP4" 2>/dev/null &
      fi
      if [ -n "$_CC_KEY_ID" ]; then
        _CC_MONTH=$(date +%Y-%m-01)
        _CC_NXMON=$(date -v+1m +%Y-%m-01)
        curl -s "https://platform.claude.com/api/organizations/$_CC_ORG/usage_cost?starting_on=$_CC_MONTH&ending_before=$_CC_NXMON&group_by=api_key_id" \\
          -H "Cookie: sessionKey=$_CC_SK" \\
          -H "Content-Type: application/json" \\
          -H "anthropic-client-platform: web_console" > "$_CC_TMP3" 2>/dev/null &
      fi
      wait
      _cc_fmt_cents() {
        if [ -n "$1" ] && [ "$1" -gt 0 ] 2>/dev/null; then printf '$%s.%02d' "$(($1/100))" "$(($1%100))"; else printf 'unavailable'; fi
      }
      _cc_fmt_limit() {
        if [ -n "$1" ] && [ "$1" != "0" ] && [ "$1" != "null" ] 2>/dev/null; then printf ' (%s)' "$(_cc_fmt_cents "$1")"; fi
      }
      _CC_ORG_AMT=$(grep -o '"amount":[0-9]*' "$_CC_TMP1" 2>/dev/null | grep -o '[0-9]*')
      if [ -s "$_CC_TMP5" ]; then
        _CC_ORG_LIMIT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); lims=[l['limit_usd'] for l in d.get('spend_limits',[]) if l['limit_action']=='notify_and_pause']; print(lims[0] if lims else '')" "$_CC_TMP5" 2>/dev/null)
      fi
      if [ -s "$_CC_TMP6" ]; then
        _CC_TIER_INFO=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); t=d.get('rate_limit_tier',''); tiers={'auto_prepaid_tier_3':('Tier 4',20000000)}; info=tiers.get(t); print(info[0]+':'+str(info[1]) if info else '')" "$_CC_TMP6" 2>/dev/null)
        _CC_TIER_NAME="\${_CC_TIER_INFO%%:*}" _CC_TIER_LIMIT="\${_CC_TIER_INFO##*:}"
      fi
      [ -n "$_CC_WS_ID" ] && _CC_WS_AMT=$(grep -o '"amount":[0-9]*' "$_CC_TMP2" 2>/dev/null | grep -o '[0-9]*')
      [ -n "$_CC_WS_ID" ] && _CC_WS_LIMIT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); lims=[l['limit_usd'] for l in d.get('spend_limits',[]) if l['limit_action']=='notify_and_pause']; print(lims[0] if lims else '')" "$_CC_TMP4" 2>/dev/null)
      if [ -n "$_CC_KEY_ID" ] && [ -s "$_CC_TMP3" ]; then
        _CC_KEY_AMT=$(KEY_ID="$_CC_KEY_ID" python3 -c "import os,json,sys; d=json.load(open(sys.argv[1])); t=sum(e['total'] for day in d['costs'].values() for e in day if e['key_id']==os.environ['KEY_ID']); print(round(t))" "$_CC_TMP3" 2>/dev/null)
      fi
      rm -f "$_CC_TMP1" "$_CC_TMP2" "$_CC_TMP3" "$_CC_TMP4" "$_CC_TMP5" "$_CC_TMP6"
      _cc_fmt_tier() {
        if [ -n "$1" ] && [ -n "$2" ] && [ "$2" != "0" ] 2>/dev/null; then printf ' [%s %s]' "$1" "$(_cc_fmt_cents "$2")"; fi
      }
      _CC_WS_STR="n/a" _CC_KEY_STR="n/a"
      [ -n "$_CC_WS_ID" ] && _CC_WS_STR="$(_cc_fmt_cents "$_CC_WS_AMT")$(_cc_fmt_limit "$_CC_WS_LIMIT")"
      [ -n "$_CC_KEY_ID" ] && _CC_KEY_STR=$(_cc_fmt_cents "$_CC_KEY_AMT")
      _CC_DEDUP="/tmp/.claude-tools-spend-$_CC_ORG"
      _CC_NOW=$(date +%s)
      _CC_PREV=$(cat "$_CC_DEDUP" 2>/dev/null || echo 0)
      if [ "$((_CC_NOW - _CC_PREV))" -ge 3 ]; then
        printf '\\n\\033[36mdirenv: spend - account: %s%s%s | workspace: %s | key: %s\\033[0m\\n' "$(_cc_fmt_cents "$_CC_ORG_AMT")" "$(_cc_fmt_limit "$_CC_ORG_LIMIT")" "$(_cc_fmt_tier "$_CC_TIER_NAME" "$_CC_TIER_LIMIT")" "$_CC_WS_STR" "$_CC_KEY_STR" > /dev/tty
        echo "$_CC_NOW" > "$_CC_DEDUP"
        [ -f "/tmp/.claude-tools-usr1-$_CC_SHELL_PID" ] && kill -USR1 $_CC_SHELL_PID 2>/dev/null
      fi
    ) </dev/null &>/dev/null 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- &
    unset _CC_META _CC_KEY_ID _CC_WS_ID
  fi
  unset _CC_ADMIN _CC_ORG _CC_SK _CC_KEY _CC_SHELL_PID
  unset -f _cc_resolve_name 2>/dev/null
fi`;

function requireMacOS(): void {
    if (process.platform !== "darwin") {
        throw new Error("Keychain operations are only supported on macOS");
    }
}

function keyHash(apiKey: string): string {
    return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function encodedDir(directory: string): string {
    return Buffer.from(directory).toString("base64");
}

function keychainName(directory: string): string {
    return `Claude Code ${encodedDir(directory)}`;
}

function securityFindPassword(service: string): string {
    requireMacOS();
    try {
        return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch {
        return "";
    }
}

function securityAddPassword(service: string, password: string): boolean {
    requireMacOS();
    try {
        execFileSync("security", ["add-generic-password", "-a", os.userInfo().username, "-s", service, "-w", password], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        return true;
    } catch {
        return false;
    }
}

function securityDeletePassword(service: string): boolean {
    requireMacOS();
    try {
        execFileSync("security", ["delete-generic-password", "-s", service], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get the display label for a key: name if set, otherwise truncated key. */
export function getKeyLabel(apiKey: string): string {
    if (!apiKey) return "(empty)";
    const name = configGet(`key_names.${keyHash(apiKey)}`);
    if (name) return name;
    return `${apiKey.slice(0, 12)}...${apiKey.slice(-4)}`;
}

/** Get the friendly name for an API key. */
export function getKeyName(apiKey: string): string {
    return configGet(`key_names.${keyHash(apiKey)}`);
}

/** Save a friendly name for an API key. */
export function saveKeyName(apiKey: string, name: string): void {
    configSet(`key_names.${keyHash(apiKey)}`, name);
}

/** Get the API key stored for a directory. */
export function getKey(directory: string): string {
    requireMacOS();
    return securityFindPassword(keychainName(directory));
}

/** Store an API key for a directory in the macOS Keychain. */
export function storeKey(directory: string, apiKey: string): boolean {
    requireMacOS();
    // Delete existing key first (keychain doesn't allow updates)
    securityDeletePassword(keychainName(directory));
    return securityAddPassword(keychainName(directory), apiKey);
}

/** Delete the API key for a directory from the macOS Keychain. */
export function deleteKey(directory: string): boolean {
    requireMacOS();
    return securityDeletePassword(keychainName(directory));
}

function metaKeychainName(directory: string): string {
    return `${keychainName(directory)}:meta`;
}

/** Get stored key metadata (key_id and workspace_id) for a directory. */
export function getKeyMeta(directory: string): { keyId: string; workspaceId: string } | null {
    requireMacOS();
    const raw = securityFindPassword(metaKeychainName(directory));
    if (!raw) return null;
    const idx = raw.indexOf(":");
    if (idx < 0) return null;
    return { keyId: raw.slice(0, idx), workspaceId: raw.slice(idx + 1) };
}

/** Store key metadata (key_id and workspace_id) for a directory. */
export function storeKeyMeta(directory: string, keyId: string, workspaceId: string): boolean {
    requireMacOS();
    securityDeletePassword(metaKeychainName(directory));
    return securityAddPassword(metaKeychainName(directory), `${keyId}:${workspaceId}`);
}

/**
 * Fetch the key's ID and workspace ID from the Console API and store them as metadata.
 *
 * Requires ANTHROPIC_ADMIN_SESSION_KEY and ANTHROPIC_ORG_ID to be set. Silently
 * returns false if either is missing or if the key cannot be matched.
 *
 * Matching uses the partial_key_hint returned by the API (e.g. "sk-ant-api03-L79...qwAA"):
 * the key must start with the prefix and end with the suffix.
 */
export async function fetchAndStoreKeyMeta(directory: string, apiKey: string, creds?: { sessionKey: string; orgId: string }): Promise<boolean> {
    const sessionKey = creds?.sessionKey ?? process.env.ANTHROPIC_ADMIN_SESSION_KEY;
    const orgId = creds?.orgId ?? process.env.ANTHROPIC_ORG_ID;
    if (!sessionKey || !orgId) return false;

    try {
        const resp = await fetch(`https://platform.claude.com/api/console/organizations/${orgId}/api_keys?limit=100`, {
            headers: {
                Cookie: `sessionKey=${sessionKey}`,
                "Content-Type": "application/json",
                "anthropic-client-platform": "web_console",
            },
        });
        if (!resp.ok) return false;
        // Console API returns a direct array; admin API returns { data: [] }
        type KeyEntry = { id: string; workspace_id: string | null; partial_key_hint: string; status?: string };
        const raw = (await resp.json()) as KeyEntry[] | { data?: KeyEntry[] };
        const keys = (Array.isArray(raw) ? raw : (raw.data ?? [])).filter((k) => k.status !== "archived");
        const match = keys.find((k) => {
            const [prefix, suffix] = k.partial_key_hint.split("...");
            return prefix && suffix && apiKey.startsWith(prefix) && apiKey.endsWith(suffix);
        });
        if (!match) return false;
        return storeKeyMeta(directory, match.id, match.workspace_id ?? "");
    } catch {
        return false;
    }
}

/** Delete key metadata for a directory from the macOS Keychain. */
export function deleteKeyMeta(directory: string): boolean {
    requireMacOS();
    return securityDeletePassword(metaKeychainName(directory));
}

// ---------------------------------------------------------------------------
// Per-directory admin credentials (org_id + session key for spend tracking)
// ---------------------------------------------------------------------------

function adminKeychainName(directory: string): string {
    return `${keychainName(directory)}:admin`;
}

/** Get stored admin credentials (org_id + session key) for a directory. */
export function getAdminCreds(directory: string): { orgId: string; sessionKey: string } | null {
    requireMacOS();
    const raw = securityFindPassword(adminKeychainName(directory));
    if (!raw) return null;
    const idx = raw.indexOf(":");
    if (idx < 0) return null;
    return { orgId: raw.slice(0, idx), sessionKey: raw.slice(idx + 1) };
}

/** Store admin credentials (org_id + session key) for a directory. */
export function storeAdminCreds(directory: string, orgId: string, sessionKey: string): boolean {
    requireMacOS();
    securityDeletePassword(adminKeychainName(directory));
    return securityAddPassword(adminKeychainName(directory), `${orgId}:${sessionKey}`);
}

/** Delete admin credentials for a directory from the macOS Keychain. */
export function deleteAdminCreds(directory: string): boolean {
    requireMacOS();
    return securityDeletePassword(adminKeychainName(directory));
}

/** Copy the API key from one directory to another. */
export function copyKey(fromDir: string, toDir: string): boolean {
    requireMacOS();
    const key = getKey(fromDir);
    if (!key) throw new Error(`No key found for: ${fromDir}`);
    const ok = storeKey(toDir, key);
    if (ok) {
        const meta = getKeyMeta(fromDir);
        if (meta) storeKeyMeta(toDir, meta.keyId, meta.workspaceId);
        const adminCreds = getAdminCreds(fromDir);
        if (adminCreds) storeAdminCreds(toDir, adminCreds.orgId, adminCreds.sessionKey);
    }
    return ok;
}

/** Get the default Claude Code API key (set by Claude Code itself). */
export function getDefaultKey(): string {
    requireMacOS();
    return securityFindPassword("Claude Code");
}

/** Copy the default Claude Code key to a specific directory. */
export function copyDefaultKey(toDir: string): boolean {
    requireMacOS();
    const key = getDefaultKey();
    if (!key) throw new Error("No default Claude Code key found in Keychain");
    return storeKey(toDir, key);
}

// ---------------------------------------------------------------------------
// Captured key management ("Claude Code Key N" persistent slots)
// ---------------------------------------------------------------------------

const CAPTURED_KEY_PREFIX = "Claude Code Key ";

function capturedKeyServiceName(slot: number): string {
    return `${CAPTURED_KEY_PREFIX}${slot}`;
}

/** Return the slot number (1-based) that already holds the given key, or null. */
function findCapturedSlot(apiKey: string): number | null {
    for (let n = 1; ; n++) {
        const existing = securityFindPassword(capturedKeyServiceName(n));
        if (!existing) return null;
        if (existing === apiKey) return n;
    }
}

/** Return the next unused slot number (slots are contiguous from 1). */
function nextCapturedSlot(): number {
    for (let n = 1; ; n++) {
        if (!securityFindPassword(capturedKeyServiceName(n))) return n;
    }
}

/**
 * Capture the current default "Claude Code" key into the next available
 * persistent slot ("Claude Code Key N") if it has not been captured yet.
 * Returns the slot number used, or null if the key was already present.
 */
export function captureDefaultKey(): number | null {
    requireMacOS();
    const key = getDefaultKey();
    if (!key) throw new Error("No default Claude Code key found in Keychain");
    if (findCapturedSlot(key) !== null) return null;
    const slot = nextCapturedSlot();
    securityAddPassword(capturedKeyServiceName(slot), key);
    return slot;
}

/** Return the key stored in the given captured slot, or empty string if absent. */
export function getCapturedKey(slot: number): string {
    requireMacOS();
    return securityFindPassword(capturedKeyServiceName(slot));
}

/** List all captured "Claude Code Key N" entries in slot order. */
export function listCapturedKeys(): CapturedKeyEntry[] {
    requireMacOS();
    const results: CapturedKeyEntry[] = [];
    for (let n = 1; ; n++) {
        const key = securityFindPassword(capturedKeyServiceName(n));
        if (!key) break;
        results.push({ slot: n, label: getKeyLabel(key) });
    }
    return results;
}

/** List all Claude Code keychain entries for other directories. */
export function listKeychainEntries(currentDir?: string): KeychainListResult {
    requireMacOS();
    const currentEncoded = currentDir ? encodedDir(currentDir) : null;

    let dumpOutput: string;
    try {
        dumpOutput = execFileSync("security", ["dump-keychain"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
        dumpOutput = "";
    }

    const otherKeys: Array<KeychainEntry & { label: string }> = [];
    const re = /"svce".*="Claude Code (.+)"/;

    for (const line of dumpOutput.split("\n")) {
        const m = re.exec(line);
        if (!m) continue;
        const enc = m[1];
        if (enc === currentEncoded) continue;
        // Skip :meta and :admin auxiliary entries
        if (enc.endsWith(":meta") || enc.endsWith(":admin")) continue;

        let dirPath: string;
        try {
            dirPath = Buffer.from(enc, "base64").toString("utf-8");
        } catch {
            continue;
        }
        if (!dirPath.startsWith("/")) continue;

        const key = securityFindPassword(`Claude Code ${enc}`);
        if (!key) continue;

        otherKeys.push({
            encodedDir: enc,
            dirPath,
            exists: fs.existsSync(dirPath),
            label: getKeyLabel(key),
        });
    }

    const currentKey = currentDir ? securityFindPassword(keychainName(currentDir)) : "";
    const defaultKey = securityFindPassword("Claude Code");

    return {
        currentKey: currentKey ? { label: getKeyLabel(currentKey) } : undefined,
        otherKeys,
        hasDefaultKey: !!defaultKey,
    };
}

/**
 * Validate an API key using the token-counting endpoint (free, no output
 * tokens consumed).  Returns a typed result indicating validity, quota
 * exhaustion, or other error.
 */
export function validateKey(apiKey: string): Promise<KeyValidationResult> {
    const body = JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "a" }],
    });

    return new Promise((resolve) => {
        const req = https.request(
            {
                hostname: "api.anthropic.com",
                path: "/v1/messages/count_tokens",
                method: "POST",
                headers: {
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let raw = "";
                res.on("data", (chunk: Buffer) => {
                    raw += chunk.toString();
                });
                res.on("end", () => {
                    try {
                        const data = JSON.parse(raw) as {
                            input_tokens?: number;
                            error?: { type: string; message: string };
                        };
                        if (data.input_tokens !== undefined) {
                            resolve({ valid: true });
                            return;
                        }
                        const msg = data.error?.message ?? "Unknown error";
                        if (data.error?.type === "authentication_error") {
                            resolve({ valid: false, error: "invalid_key", message: msg });
                            return;
                        }
                        if (msg.includes("usage limits")) {
                            const match = msg.match(/regain access on (.+?) at/);
                            resolve({ valid: false, error: "quota_exhausted", message: msg, quotaResetsAt: match?.[1] });
                            return;
                        }
                        resolve({ valid: false, error: "unknown", message: msg });
                    } catch {
                        resolve({ valid: false, error: "unknown", message: raw });
                    }
                });
            }
        );
        req.on("error", (err: Error) => resolve({ valid: false, error: "network_error", message: err.message }));
        req.write(body);
        req.end();
    });
}

const ENVRC_BEGIN = "# --- claude-tools begin ---";
const ENVRC_END = "# --- claude-tools end ---";

function snippetHash(snippet: string): string {
    return crypto.createHash("sha256").update(snippet).digest("hex").slice(0, 16);
}

function wrappedSnippet(): string {
    return `${ENVRC_BEGIN}\n${ENVRC_SNIPPET}\n${ENVRC_END}`;
}

function extractManagedBlock(content: string): string | null {
    const beginIdx = content.indexOf(ENVRC_BEGIN);
    const endIdx = content.indexOf(ENVRC_END);
    if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return null;
    return content.slice(beginIdx + ENVRC_BEGIN.length + 1, endIdx).replace(/\n$/, "");
}

/** Ensure .envrc in a directory contains the keychain lookup snippet. */
export function ensureEnvrc(directory: string): { created: boolean; appended: boolean; alreadyPresent: boolean; upgraded: boolean } {
    const envrc = path.join(directory, ".envrc");

    if (fs.existsSync(envrc)) {
        const content = fs.readFileSync(envrc, "utf-8");

        // Delimited format: compare hash of managed block against current snippet
        const managed = extractManagedBlock(content);
        if (managed !== null) {
            if (snippetHash(managed) === snippetHash(ENVRC_SNIPPET)) {
                return { created: false, appended: false, alreadyPresent: true, upgraded: false };
            }
            // Hash mismatch: replace the managed block
            removeEnvrcSnippet(directory);
            if (fs.existsSync(envrc)) {
                fs.appendFileSync(envrc, "\n" + wrappedSnippet() + "\n");
            } else {
                fs.writeFileSync(envrc, wrappedSnippet() + "\n");
            }
            return { created: false, appended: false, alreadyPresent: false, upgraded: true };
        }

        // Legacy format (no delimiters): upgrade
        if (content.includes("# managed by claude-tools") || content.includes("Claude Code $ENCODED_DIR")) {
            removeEnvrcSnippet(directory);
            if (fs.existsSync(envrc)) {
                fs.appendFileSync(envrc, "\n" + wrappedSnippet() + "\n");
            } else {
                fs.writeFileSync(envrc, wrappedSnippet() + "\n");
            }
            return { created: false, appended: false, alreadyPresent: false, upgraded: true };
        }

        fs.appendFileSync(envrc, "\n" + wrappedSnippet() + "\n");
        return { created: false, appended: true, alreadyPresent: false, upgraded: false };
    }

    fs.writeFileSync(envrc, wrappedSnippet() + "\n");
    return { created: true, appended: false, alreadyPresent: false, upgraded: false };
}

/**
 * Remove key name entries from key-config.json that no longer have a
 * corresponding key in the macOS Keychain.  Returns the number of entries
 * pruned.
 */
export function pruneOrphanedKeyNames(): number {
    requireMacOS();
    ensureConfig();

    const activeHashes = new Set<string>();

    const defaultKey = getDefaultKey();
    if (defaultKey) activeHashes.add(keyHash(defaultKey));

    let dumpOutput = "";
    try {
        dumpOutput = execFileSync("security", ["dump-keychain"], {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });
    } catch {
        dumpOutput = "";
    }

    const re = /"svce".*="Claude Code (.+)"/;
    for (const line of dumpOutput.split("\n")) {
        const m = re.exec(line);
        if (!m) continue;
        const key = securityFindPassword(`Claude Code ${m[1]}`);
        if (key) activeHashes.add(keyHash(key));
    }

    // Explicitly walk captured slots in case dump-keychain output is incomplete
    for (let n = 1; ; n++) {
        const key = securityFindPassword(capturedKeyServiceName(n));
        if (!key) break;
        activeHashes.add(keyHash(key));
    }

    const d = JSON.parse(fs.readFileSync(getConfigFile(), "utf-8"));
    const keyNames = d.key_names as Record<string, string> | undefined;
    if (!keyNames) return 0;

    let pruned = 0;
    for (const hash of Object.keys(keyNames)) {
        if (!activeHashes.has(hash)) {
            delete keyNames[hash];
            pruned++;
        }
    }

    if (pruned > 0) {
        fs.writeFileSync(getConfigFile(), JSON.stringify(d, null, 2));
    }

    return pruned;
}

const ZSH_HOOK_MARKER = "# claude-tools: async prompt redraw";
const ZSH_HOOK_SNIPPET = `${ZSH_HOOK_MARKER}
TRAPUSR1() { if [[ -o zle ]]; then zle reset-prompt; fi }
: > "/tmp/.claude-tools-usr1-$$"`;

function zshrcPath(): string {
    return path.join(process.env.HOME || os.homedir(), ".zshrc");
}

/**
 * Check whether the SIGUSR1 prompt-redraw hook is present in ~/.zshrc.
 */
export function hasZshHook(): boolean {
    const zshrc = zshrcPath();
    if (!fs.existsSync(zshrc)) return false;
    return fs.readFileSync(zshrc, "utf-8").includes(ZSH_HOOK_MARKER);
}

/**
 * Append the SIGUSR1 prompt-redraw hook to ~/.zshrc.
 * The hook allows background processes (like .envrc async spend display)
 * to trigger a clean zsh prompt redraw after printing to /dev/tty.
 */
export function installZshHook(): { installed: boolean; alreadyPresent: boolean } {
    if (hasZshHook()) return { installed: false, alreadyPresent: true };
    const zshrc = zshrcPath();
    const existing = fs.existsSync(zshrc) ? fs.readFileSync(zshrc, "utf-8") : "";
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : "\n";
    fs.appendFileSync(zshrc, `${separator}${ZSH_HOOK_SNIPPET}\n`);
    return { installed: true, alreadyPresent: false };
}

/** Remove the keychain lookup snippet from .envrc. */
export function removeEnvrcSnippet(directory: string): { removed: boolean; fileDeleted: boolean } {
    const envrc = path.join(directory, ".envrc");
    if (!fs.existsSync(envrc)) return { removed: false, fileDeleted: false };

    let content = fs.readFileSync(envrc, "utf-8");

    // Remove delimited block
    const beginRe = new RegExp(
        `^${ENVRC_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n.*?^${ENVRC_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
        "ms"
    );
    content = content.replace(beginRe, "");

    // Remove legacy formats
    content = content.replace(/^# managed by claude-tools$.*?^fi$\n?/ms, "").replace(/^ENCODED_DIR=\$\(echo -n "\$PWD" \| base64\)$.*?^fi$\n?/ms, "");

    const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();

    if (!cleaned) {
        fs.unlinkSync(envrc);
        return { removed: true, fileDeleted: true };
    }

    fs.writeFileSync(envrc, cleaned + "\n");
    return { removed: true, fileDeleted: false };
}
