// ---------------------------------------------------------------------------
// Low-level macOS Keychain primitives shared by the auth modules.
// ---------------------------------------------------------------------------

import * as crypto from "node:crypto";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

export function requireMacOS(): void {
    if (process.platform !== "darwin") {
        throw new Error("Keychain operations are only supported on macOS");
    }
}

export function keyHash(apiKey: string): string {
    return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export function encodedDir(directory: string): string {
    return Buffer.from(directory).toString("base64");
}

export function keychainName(directory: string): string {
    return `Claude Code ${encodedDir(directory)}`;
}

export function securityFindPassword(service: string): string {
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

export function securityAddPassword(service: string, password: string): boolean {
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

export function securityDeletePassword(service: string): boolean {
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
