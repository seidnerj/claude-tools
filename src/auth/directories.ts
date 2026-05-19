// ---------------------------------------------------------------------------
// Per-directory chain assignments. Stored as a single JSON file mapping
// base64(directory) -> chain-id at ~/.claude-tools/directories.json.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { CLAUDE_TOOLS_DIR } from "./envrc.js";
import { encodedDir } from "./keychain.js";

export const DIRECTORIES_FILE = path.join(CLAUDE_TOOLS_DIR, "directories.json");

type DirectoryMap = Record<string, string>;

function ensureToolsDir(): void {
    if (!fs.existsSync(CLAUDE_TOOLS_DIR)) {
        fs.mkdirSync(CLAUDE_TOOLS_DIR, { recursive: true });
    }
}

function readMap(): DirectoryMap {
    if (!fs.existsSync(DIRECTORIES_FILE)) return {};
    try {
        const raw = JSON.parse(fs.readFileSync(DIRECTORIES_FILE, "utf-8")) as unknown;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            return raw as DirectoryMap;
        }
        return {};
    } catch {
        return {};
    }
}

function writeMap(map: DirectoryMap): void {
    ensureToolsDir();
    fs.writeFileSync(DIRECTORIES_FILE, JSON.stringify(map, null, 2) + "\n");
}

export function getDirectoryChain(directory: string): string | null {
    const map = readMap();
    return map[encodedDir(directory)] ?? null;
}

export function setDirectoryChain(directory: string, chainId: string): void {
    const map = readMap();
    map[encodedDir(directory)] = chainId;
    writeMap(map);
}

export function unsetDirectoryChain(directory: string): boolean {
    const map = readMap();
    const key = encodedDir(directory);
    if (!(key in map)) return false;
    delete map[key];
    writeMap(map);
    return true;
}

export function listDirectoryAssignments(): Array<{ directory: string; chainId: string; exists: boolean }> {
    const map = readMap();
    const results: Array<{ directory: string; chainId: string; exists: boolean }> = [];
    for (const [enc, chainId] of Object.entries(map)) {
        let directory: string;
        try {
            directory = Buffer.from(enc, "base64").toString("utf-8");
        } catch {
            continue;
        }
        results.push({ directory, chainId, exists: fs.existsSync(directory) });
    }
    return results.sort((a, b) => a.directory.localeCompare(b.directory));
}

export function directoriesUsingChain(chainId: string): string[] {
    return listDirectoryAssignments()
        .filter((a) => a.chainId === chainId)
        .map((a) => a.directory);
}
