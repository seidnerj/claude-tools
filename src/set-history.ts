// ---------------------------------------------------------------------------
// Copy, move, and delete Claude Code project history
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import type { CopyHistoryResult, DeleteHistoryResult, MoveHistoryResult } from "./types.js";
import { PROJECTS_DIR, HISTORY_FILE, pathToDirname, preserveMtime, requireProjectsDir } from "./utils.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Escape a string for use in a RegExp. */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Check whether a path is an existing directory. */
function isDir(p: string): boolean {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

/** Replace all occurrences of oldPath references with newPath in session .jsonl files. */
async function updateSessionRefs(projectDir: string, oldPath: string, newPath: string): Promise<number> {
    let updated = 0;
    const oldRef = `"${oldPath}"`;
    const newRef = `"${newPath}"`;
    const pattern = new RegExp(escapeRegExp(oldRef), "g");

    for (const fname of fs.readdirSync(projectDir).sort()) {
        if (!fname.endsWith(".jsonl")) continue;
        const filepath = path.join(projectDir, fname);
        if (!fs.statSync(filepath).isFile()) continue;

        let content = fs.readFileSync(filepath, "utf-8");
        if (content.includes(oldRef)) {
            content = content.replace(pattern, newRef);
            await preserveMtime(filepath, () => {
                fs.writeFileSync(filepath, content);
            });
            updated++;
        }
    }
    return updated;
}

/** Replace path references in sessions-index.json. */
function updateSessionsIndex(projectDir: string, oldDirName: string, newDirName: string, oldPath: string, newPath: string): boolean {
    const sessionsIndex = path.join(projectDir, "sessions-index.json");
    if (!fs.existsSync(sessionsIndex)) return false;

    let content = fs.readFileSync(sessionsIndex, "utf-8");
    content = content.replace(new RegExp(escapeRegExp(oldDirName), "g"), newDirName);
    content = content.replace(new RegExp(escapeRegExp(`"${oldPath}"`), "g"), `"${newPath}"`);
    fs.writeFileSync(sessionsIndex, content);
    return true;
}

/** Duplicate history.jsonl entries that reference sourcePath, adding copies with destPath. */
function duplicateHistoryEntries(sourcePath: string, destPath: string): boolean {
    if (!fs.existsSync(HISTORY_FILE)) return false;

    const content = fs.readFileSync(HISTORY_FILE, "utf-8");
    const sourceRef = `"${sourcePath}"`;
    if (!content.includes(sourceRef)) return false;

    const pattern = new RegExp(escapeRegExp(sourceRef), "g");
    const lines = content.split("\n");
    const newLines: string[] = [];
    for (const line of lines) {
        if (line.includes(sourceRef)) {
            newLines.push(line.replace(pattern, `"${destPath}"`));
        }
    }
    if (newLines.length === 0) return false;

    const trailing = content.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(HISTORY_FILE, content + trailing + newLines.join("\n") + "\n");
    return true;
}

/** Remove history.jsonl entries that reference targetPath. */
function removeHistoryEntries(targetPath: string): boolean {
    if (!fs.existsSync(HISTORY_FILE)) return false;

    const content = fs.readFileSync(HISTORY_FILE, "utf-8");
    const targetRef = `"${targetPath}"`;
    if (!content.includes(targetRef)) return false;

    const lines = content.split("\n");
    const filtered = lines.filter((line) => !line.includes(targetRef));
    fs.writeFileSync(HISTORY_FILE, filtered.join("\n"));
    return true;
}

// ---------------------------------------------------------------------------
// Per-session helpers
// ---------------------------------------------------------------------------

/** Check which session IDs have .jsonl files in a project directory. */
function collectSessionFiles(projectDir: string, sessionIds: string[]): { found: string[]; notFound: string[] } {
    const found: string[] = [];
    const notFound: string[] = [];
    for (const id of sessionIds) {
        const jsonlPath = path.join(projectDir, `${id}.jsonl`);
        if (fs.existsSync(jsonlPath) && fs.statSync(jsonlPath).isFile()) {
            found.push(id);
        } else {
            notFound.push(id);
        }
    }
    return { found, notFound };
}

/** Copy specific session files (.jsonl + companion directory) from source to dest. */
function copySessionFiles(sourceDir: string, destDir: string, sessionIds: string[]): void {
    fs.mkdirSync(destDir, { recursive: true });
    for (const id of sessionIds) {
        const jsonlSrc = path.join(sourceDir, `${id}.jsonl`);
        const jsonlDst = path.join(destDir, `${id}.jsonl`);
        fs.copyFileSync(jsonlSrc, jsonlDst);

        const companionSrc = path.join(sourceDir, id);
        if (fs.existsSync(companionSrc) && fs.statSync(companionSrc).isDirectory()) {
            fs.cpSync(companionSrc, path.join(destDir, id), { recursive: true });
        }
    }
}

/** Delete specific session files (.jsonl + companion directory) from a project directory. */
function deleteSessionFiles(projectDir: string, sessionIds: string[]): void {
    for (const id of sessionIds) {
        const jsonlPath = path.join(projectDir, `${id}.jsonl`);
        if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);

        const companionDir = path.join(projectDir, id);
        if (fs.existsSync(companionDir) && fs.statSync(companionDir).isDirectory()) {
            fs.rmSync(companionDir, { recursive: true });
        }
    }
}

/** Like updateSessionRefs but only processes specific session .jsonl files. */
async function updateSessionRefsForFiles(projectDir: string, sessionIds: string[], oldPath: string, newPath: string): Promise<number> {
    let updated = 0;
    const oldRef = `"${oldPath}"`;
    const newRef = `"${newPath}"`;
    const pattern = new RegExp(escapeRegExp(oldRef), "g");

    for (const id of sessionIds) {
        const filepath = path.join(projectDir, `${id}.jsonl`);
        if (!fs.existsSync(filepath) || !fs.statSync(filepath).isFile()) continue;

        let content = fs.readFileSync(filepath, "utf-8");
        if (content.includes(oldRef)) {
            content = content.replace(pattern, newRef);
            await preserveMtime(filepath, () => {
                fs.writeFileSync(filepath, content);
            });
            updated++;
        }
    }
    return updated;
}

/** Ensure a project directory exists under ~/.claude/projects/, creating it with a minimal sessions-index.json if needed. */
function ensureProjectDir(projectPath: string): string {
    const dirName = pathToDirname(projectPath);
    const projectDir = path.join(PROJECTS_DIR, dirName);
    if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
        const sessionsIndex = path.join(projectDir, "sessions-index.json");
        fs.writeFileSync(sessionsIndex, JSON.stringify({ version: 1, entries: [], originalPath: projectPath }));
    }
    return projectDir;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Remove broken resume artifacts from session .jsonl files.
 *
 * Looks for sessions where a good summary is followed by junk summaries
 * (starting with "I don" or "Unable to generate") and truncates the file
 * after the last good summary.
 *
 * Returns the number of files cleaned.
 */
export function cleanBrokenResumeArtifacts(projectDir: string): number {
    let cleaned = 0;

    for (const fname of fs.readdirSync(projectDir).sort()) {
        if (!fname.endsWith(".jsonl")) continue;
        const filepath = path.join(projectDir, fname);
        if (!fs.statSync(filepath).isFile()) continue;

        const lines = fs.readFileSync(filepath, "utf-8").split("\n");

        let lastGoodSummaryIdx: number | null = null;
        for (let i = 0; i < lines.length; i++) {
            const stripped = lines[i].trim();
            if (!stripped) continue;
            try {
                const e = JSON.parse(stripped) as { type?: string; summary?: string };
                if (e.type === "summary") {
                    const s = e.summary || "";
                    if (s && !s.startsWith("I don") && !s.startsWith("Unable to generate")) {
                        lastGoodSummaryIdx = i;
                    }
                }
            } catch {
                // ignore parse errors
            }
        }

        if (lastGoodSummaryIdx === null) continue;

        let hasJunk = false;
        for (let i = lastGoodSummaryIdx + 1; i < lines.length; i++) {
            const stripped = lines[i].trim();
            if (!stripped) continue;
            try {
                const e = JSON.parse(stripped) as { type?: string; summary?: string };
                if (e.type === "summary") {
                    const s = e.summary || "";
                    if (s.startsWith("I don") || s.startsWith("Unable to generate")) {
                        hasJunk = true;
                        break;
                    }
                }
            } catch {
                // ignore parse errors
            }
        }

        if (hasJunk) {
            const goodLines = lines.slice(0, lastGoodSummaryIdx + 1);
            const stat = fs.statSync(filepath);
            fs.writeFileSync(filepath, goodLines.join("\n"));
            fs.utimesSync(filepath, stat.atime, stat.mtime);
            cleaned++;
        }
    }

    return cleaned;
}

/** Copy Claude Code history from one project path to another, keeping the source intact.
 *
 * When sessionIds is omitted, copies the entire project directory (all sessions).
 * When sessionIds is provided, copies only the specified sessions - the destination
 * project directory may already exist (sessions are merged into it).
 */
export async function copyHistory(sourcePath: string, destPath: string, sessionIds?: string[]): Promise<CopyHistoryResult> {
    requireProjectsDir();

    sourcePath = path.resolve(sourcePath).replace(/\/+$/, "");
    destPath = path.resolve(destPath).replace(/\/+$/, "");

    if (sourcePath === destPath) {
        throw new Error("Source and destination paths are identical.");
    }

    const sourceDirName = pathToDirname(sourcePath);
    const destDirName = pathToDirname(destPath);
    const sourceProjectDir = path.join(PROJECTS_DIR, sourceDirName);
    const destProjectDir = path.join(PROJECTS_DIR, destDirName);

    if (!isDir(sourceProjectDir)) {
        throw new Error(`No Claude history found for source path: ${sourcePath}`);
    }

    // Per-session copy
    if (sessionIds) {
        if (sessionIds.length === 0) {
            throw new Error("session_ids must contain at least one session ID.");
        }

        const { found, notFound } = collectSessionFiles(sourceProjectDir, sessionIds);

        ensureProjectDir(destPath);
        if (found.length > 0) {
            copySessionFiles(sourceProjectDir, destProjectDir, found);
        }

        const sessionFilesUpdated = found.length > 0 ? await updateSessionRefsForFiles(destProjectDir, found, sourcePath, destPath) : 0;

        return {
            sourcePath,
            destPath,
            sessionFilesUpdated,
            sessionsIndexUpdated: false,
            historyFileUpdated: false,
            brokenArtifactsCleaned: 0,
            sessionIds: found,
            sessionsNotFound: notFound.length > 0 ? notFound : undefined,
        };
    }

    // Whole-project copy (existing behavior)
    if (isDir(destProjectDir)) {
        throw new Error(`Claude history already exists for destination path: ${destPath}`);
    }

    fs.cpSync(sourceProjectDir, destProjectDir, { recursive: true });

    const sessionFilesUpdated = await updateSessionRefs(destProjectDir, sourcePath, destPath);
    const sessionsIndexUpdated = updateSessionsIndex(destProjectDir, sourceDirName, destDirName, sourcePath, destPath);
    const historyFileUpdated = duplicateHistoryEntries(sourcePath, destPath);
    const brokenArtifactsCleaned = cleanBrokenResumeArtifacts(destProjectDir);

    return {
        sourcePath,
        destPath,
        sessionFilesUpdated,
        sessionsIndexUpdated,
        historyFileUpdated,
        brokenArtifactsCleaned,
    };
}

/** Delete Claude Code history for a project path.
 *
 * When sessionIds is omitted, removes the entire project directory and all sessions.
 * When sessionIds is provided, deletes only the specified sessions - the project
 * directory and remaining sessions are preserved.
 */
export async function deleteHistory(targetPath: string, sessionIds?: string[]): Promise<DeleteHistoryResult> {
    requireProjectsDir();

    targetPath = path.resolve(targetPath).replace(/\/+$/, "");

    const dirName = pathToDirname(targetPath);
    const projectDir = path.join(PROJECTS_DIR, dirName);

    if (!isDir(projectDir)) {
        throw new Error(`No Claude history found for path: ${targetPath}`);
    }

    // Per-session delete
    if (sessionIds) {
        if (sessionIds.length === 0) {
            throw new Error("session_ids must contain at least one session ID.");
        }

        const { found, notFound } = collectSessionFiles(projectDir, sessionIds);
        if (found.length > 0) {
            deleteSessionFiles(projectDir, found);
        }

        return {
            targetPath,
            historyFileUpdated: false,
            sessionIds: found,
            sessionsNotFound: notFound.length > 0 ? notFound : undefined,
        };
    }

    // Whole-project delete (existing behavior)
    fs.rmSync(projectDir, { recursive: true });

    const historyFileUpdated = removeHistoryEntries(targetPath);

    return { targetPath, historyFileUpdated };
}

/** Move Claude Code history from one project path to another.
 *
 * When sessionIds is omitted, moves the entire project directory (all sessions).
 * When sessionIds is provided, moves only the specified sessions - both source and
 * destination project directories may already exist.
 */
export async function moveHistory(oldPath: string, newPath: string, sessionIds?: string[]): Promise<MoveHistoryResult> {
    requireProjectsDir();

    oldPath = path.resolve(oldPath).replace(/\/+$/, "");
    newPath = path.resolve(newPath).replace(/\/+$/, "");

    if (oldPath === newPath) {
        throw new Error("Old and new paths are identical.");
    }

    const oldDirName = pathToDirname(oldPath);
    const newDirName = pathToDirname(newPath);
    const oldProjectDir = path.join(PROJECTS_DIR, oldDirName);
    const newProjectDir = path.join(PROJECTS_DIR, newDirName);

    const oldExists = isDir(oldProjectDir);
    const newExists = isDir(newProjectDir);

    // Per-session move
    if (sessionIds) {
        if (sessionIds.length === 0) {
            throw new Error("session_ids must contain at least one session ID.");
        }

        if (!oldExists) {
            throw new Error(`No Claude history found for source path: ${oldPath}`);
        }

        const copyResult = await copyHistory(oldPath, newPath, sessionIds);

        const found = copyResult.sessionIds || [];
        if (found.length > 0) {
            deleteSessionFiles(oldProjectDir, found);
        }

        return {
            oldPath,
            newPath,
            sessionFilesUpdated: copyResult.sessionFilesUpdated,
            sessionsIndexUpdated: false,
            historyFileUpdated: false,
            brokenArtifactsCleaned: 0,
            sessionIds: found,
            sessionsNotFound: copyResult.sessionsNotFound,
        };
    }

    // Whole-project move (existing behavior)
    if (oldExists && newExists) {
        throw new Error("Both old and new project directories exist. Cannot merge automatically.");
    }

    if (!oldExists && !newExists) {
        throw new Error("No Claude history found for either path.");
    }

    if (oldExists) {
        // Normal case: copy to new location, then delete old
        const copyResult = await copyHistory(oldPath, newPath);
        const deleteResult = await deleteHistory(oldPath);

        return {
            oldPath,
            newPath,
            sessionFilesUpdated: copyResult.sessionFilesUpdated,
            sessionsIndexUpdated: copyResult.sessionsIndexUpdated,
            historyFileUpdated: copyResult.historyFileUpdated || deleteResult.historyFileUpdated,
            brokenArtifactsCleaned: copyResult.brokenArtifactsCleaned,
        };
    }

    // Edge case: directory already moved/renamed outside of this tool,
    // just update the stale path references
    const sessionFilesUpdated = await updateSessionRefs(newProjectDir, oldPath, newPath);
    const sessionsIndexUpdated = updateSessionsIndex(newProjectDir, oldDirName, newDirName, oldPath, newPath);

    let historyFileUpdated = false;
    if (fs.existsSync(HISTORY_FILE)) {
        let content = fs.readFileSync(HISTORY_FILE, "utf-8");
        const oldRef = `"${oldPath}"`;
        if (content.includes(oldRef)) {
            content = content.replace(new RegExp(escapeRegExp(oldRef), "g"), `"${newPath}"`);
            fs.writeFileSync(HISTORY_FILE, content);
            historyFileUpdated = true;
        }
    }

    const brokenArtifactsCleaned = cleanBrokenResumeArtifacts(newProjectDir);

    return {
        oldPath,
        newPath,
        sessionFilesUpdated,
        sessionsIndexUpdated,
        historyFileUpdated,
        brokenArtifactsCleaned,
    };
}
