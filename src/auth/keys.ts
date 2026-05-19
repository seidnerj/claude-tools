// ---------------------------------------------------------------------------
// Per-directory API key storage in the macOS Keychain, plus name/label helpers
// and captured key slots ("Claude Code Key N").
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { CapturedKeyEntry, KeychainEntry, KeychainListResult } from "../types.js";
import { configGet, configSet, getConfigFile, ensureConfig } from "../utils.js";
import { encodedDir, keychainName, keyHash, requireMacOS, securityAddPassword, securityDeletePassword, securityFindPassword } from "./keychain.js";
import {
    getKeyMeta as _getKeyMeta,
    storeKeyMeta as _storeKeyMeta,
    getAdminCreds as _getAdminCreds,
    storeAdminCreds as _storeAdminCreds,
} from "./metadata.js";

export function getKeyLabel(apiKey: string): string {
    if (!apiKey) return "(empty)";
    const name = configGet(`key_names.${keyHash(apiKey)}`);
    if (name) return name;
    return `${apiKey.slice(0, 12)}...${apiKey.slice(-4)}`;
}

export function getKeyName(apiKey: string): string {
    return configGet(`key_names.${keyHash(apiKey)}`);
}

export function saveKeyName(apiKey: string, name: string): void {
    configSet(`key_names.${keyHash(apiKey)}`, name);
}

export function getKey(directory: string): string {
    requireMacOS();
    return securityFindPassword(keychainName(directory));
}

export function storeKey(directory: string, apiKey: string): boolean {
    requireMacOS();
    securityDeletePassword(keychainName(directory));
    return securityAddPassword(keychainName(directory), apiKey);
}

export function deleteKey(directory: string): boolean {
    requireMacOS();
    return securityDeletePassword(keychainName(directory));
}

export function copyKey(fromDir: string, toDir: string): boolean {
    requireMacOS();
    const key = getKey(fromDir);
    if (!key) throw new Error(`No key found for: ${fromDir}`);
    const ok = storeKey(toDir, key);
    if (ok) {
        const m = _getKeyMeta(fromDir);
        if (m) _storeKeyMeta(toDir, m.keyId, m.workspaceId);
        const adminCreds = _getAdminCreds(fromDir);
        if (adminCreds) _storeAdminCreds(toDir, adminCreds.sessionKey);
    }
    return ok;
}

export function getDefaultKey(): string {
    requireMacOS();
    return securityFindPassword("Claude Code");
}

export function copyDefaultKey(toDir: string): boolean {
    requireMacOS();
    const key = getDefaultKey();
    if (!key) throw new Error("No default Claude Code key found in Keychain");
    return storeKey(toDir, key);
}

const CAPTURED_KEY_PREFIX = "Claude Code Key ";

function capturedKeyServiceName(slot: number): string {
    return `${CAPTURED_KEY_PREFIX}${slot}`;
}

function findCapturedSlot(apiKey: string): number | null {
    for (let n = 1; ; n++) {
        const existing = securityFindPassword(capturedKeyServiceName(n));
        if (!existing) return null;
        if (existing === apiKey) return n;
    }
}

function nextCapturedSlot(): number {
    for (let n = 1; ; n++) {
        if (!securityFindPassword(capturedKeyServiceName(n))) return n;
    }
}

export function captureDefaultKey(): number | null {
    requireMacOS();
    const key = getDefaultKey();
    if (!key) throw new Error("No default Claude Code key found in Keychain");
    if (findCapturedSlot(key) !== null) return null;
    const slot = nextCapturedSlot();
    securityAddPassword(capturedKeyServiceName(slot), key);
    return slot;
}

export function getCapturedKey(slot: number): string {
    requireMacOS();
    return securityFindPassword(capturedKeyServiceName(slot));
}

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
