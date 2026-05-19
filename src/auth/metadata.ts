// ---------------------------------------------------------------------------
// Per-directory key metadata (key_id, workspace_id) and admin credentials
// (Console session key) stored in the macOS Keychain.
// ---------------------------------------------------------------------------

import { keychainName, requireMacOS, securityAddPassword, securityDeletePassword, securityFindPassword } from "./keychain.js";

function metaKeychainName(directory: string): string {
    return `${keychainName(directory)}:meta`;
}

function adminKeychainName(directory: string): string {
    return `${keychainName(directory)}:admin`;
}

export function getKeyMeta(directory: string): { keyId: string; workspaceId: string } | null {
    requireMacOS();
    const raw = securityFindPassword(metaKeychainName(directory));
    if (!raw) return null;
    const idx = raw.indexOf(":");
    if (idx < 0) return null;
    return { keyId: raw.slice(0, idx), workspaceId: raw.slice(idx + 1) };
}

export function storeKeyMeta(directory: string, keyId: string, workspaceId: string): boolean {
    requireMacOS();
    securityDeletePassword(metaKeychainName(directory));
    return securityAddPassword(metaKeychainName(directory), `${keyId}:${workspaceId}`);
}

export function deleteKeyMeta(directory: string): boolean {
    requireMacOS();
    return securityDeletePassword(metaKeychainName(directory));
}

export function getAdminCreds(directory: string): { sessionKey: string } | null {
    requireMacOS();
    const raw = securityFindPassword(adminKeychainName(directory));
    if (!raw) return null;
    return { sessionKey: raw };
}

export function storeAdminCreds(directory: string, sessionKey: string): boolean {
    requireMacOS();
    securityDeletePassword(adminKeychainName(directory));
    return securityAddPassword(adminKeychainName(directory), sessionKey);
}

export function deleteAdminCreds(directory: string): boolean {
    requireMacOS();
    return securityDeletePassword(adminKeychainName(directory));
}
