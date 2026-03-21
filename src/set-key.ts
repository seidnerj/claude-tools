// ---------------------------------------------------------------------------
// Manage per-directory Anthropic API keys in macOS Keychain
// ---------------------------------------------------------------------------

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { CapturedKeyEntry, KeychainEntry, KeychainListResult } from "./types.js";

function getConfigFile(): string {
    return path.join(os.homedir(), ".claude", "key-config.json");
}

const ENVRC_SNIPPET = `ENCODED_DIR=$(echo -n "$PWD" | base64)
API_KEY=$(security find-generic-password -s "Claude Code $ENCODED_DIR" -w 2>/dev/null)

if [ -n "$API_KEY" ]; then
  export ANTHROPIC_API_KEY="$API_KEY"
fi`;

function requireMacOS(): void {
    if (process.platform !== "darwin") {
        throw new Error("Keychain operations are only supported on macOS");
    }
}

function ensureConfig(): void {
    const dir = path.join(os.homedir(), ".claude");
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(getConfigFile())) {
        fs.writeFileSync(getConfigFile(), "{}");
    }
}

function configGet(configPath: string, defaultValue = ""): string {
    ensureConfig();
    const d = JSON.parse(fs.readFileSync(getConfigFile(), "utf-8"));
    const keys = configPath.split(".");
    let obj = d;
    for (const k of keys) {
        if (obj == null || typeof obj !== "object") return defaultValue;
        obj = obj[k];
    }
    return obj != null ? String(obj) : defaultValue;
}

function configSet(configPath: string, value: string): void {
    ensureConfig();
    const d = JSON.parse(fs.readFileSync(getConfigFile(), "utf-8"));
    const keys = configPath.split(".");
    let obj = d;
    for (const k of keys.slice(0, -1)) {
        if (obj[k] == null || typeof obj[k] !== "object") obj[k] = {};
        obj = obj[k];
    }
    obj[keys[keys.length - 1]] = value;
    fs.writeFileSync(getConfigFile(), JSON.stringify(d, null, 2));
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

/** Copy the API key from one directory to another. */
export function copyKey(fromDir: string, toDir: string): boolean {
    requireMacOS();
    const key = getKey(fromDir);
    if (!key) throw new Error(`No key found for: ${fromDir}`);
    return storeKey(toDir, key);
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

/** Ensure .envrc in a directory contains the keychain lookup snippet. */
export function ensureEnvrc(directory: string): { created: boolean; appended: boolean; alreadyPresent: boolean } {
    const envrc = path.join(directory, ".envrc");

    if (fs.existsSync(envrc)) {
        const content = fs.readFileSync(envrc, "utf-8");
        if (content.includes("Claude Code $ENCODED_DIR")) {
            return { created: false, appended: false, alreadyPresent: true };
        }
        fs.appendFileSync(envrc, "\n" + ENVRC_SNIPPET + "\n");
        return { created: false, appended: true, alreadyPresent: false };
    }

    fs.writeFileSync(envrc, ENVRC_SNIPPET + "\n");
    return { created: true, appended: false, alreadyPresent: false };
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

/** Remove the keychain lookup snippet from .envrc. */
export function removeEnvrcSnippet(directory: string): { removed: boolean; fileDeleted: boolean } {
    const envrc = path.join(directory, ".envrc");
    if (!fs.existsSync(envrc)) return { removed: false, fileDeleted: false };

    let content = fs.readFileSync(envrc, "utf-8");
    let cleaned = content.replace(/^ENCODED_DIR=\$\(echo -n "\$PWD" \| base64\)$.*?^fi$\n?/ms, "");
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

    if (!cleaned) {
        fs.unlinkSync(envrc);
        return { removed: true, fileDeleted: true };
    }

    fs.writeFileSync(envrc, cleaned + "\n");
    return { removed: true, fileDeleted: false };
}
