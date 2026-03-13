// ---------------------------------------------------------------------------
// Move Claude Code project history when renaming/moving a project directory
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import type { MoveHistoryResult } from "./types.js";
import { PROJECTS_DIR, HISTORY_FILE, pathToDirname, preserveMtime, requireProjectsDir } from "./utils.js";

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

/** Move Claude Code history from one project path to another.
 *
 * Renames the project directory under ~/.claude/projects/, fixes cwd
 * references in session files, updates sessions-index.json, and fixes
 * the global history.jsonl.
 */
export async function moveHistory(oldPath: string, newPath: string): Promise<MoveHistoryResult> {
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

    const oldExists = fs.existsSync(oldProjectDir) && fs.statSync(oldProjectDir).isDirectory();
    const newExists = fs.existsSync(newProjectDir) && fs.statSync(newProjectDir).isDirectory();

    if (oldExists && newExists) {
        throw new Error("Both old and new project directories exist. Cannot merge automatically.");
    }

    if (!oldExists && !newExists) {
        throw new Error("No Claude history found for either path.");
    }

    // Rename project directory
    if (oldExists) {
        fs.renameSync(oldProjectDir, newProjectDir);
    }

    // Fix session .jsonl files (cwd fields)
    let sessionFilesUpdated = 0;
    for (const fname of fs.readdirSync(newProjectDir).sort()) {
        if (!fname.endsWith(".jsonl")) continue;
        const filepath = path.join(newProjectDir, fname);
        if (!fs.statSync(filepath).isFile()) continue;

        let content = fs.readFileSync(filepath, "utf-8");
        const oldRef = `"${oldPath}"`;
        const newRef = `"${newPath}"`;
        if (content.includes(oldRef)) {
            content = content.replace(new RegExp(oldRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), newRef);
            await preserveMtime(filepath, () => {
                fs.writeFileSync(filepath, content);
            });
            sessionFilesUpdated++;
        }
    }

    // Fix sessions-index.json
    let sessionsIndexUpdated = false;
    const sessionsIndex = path.join(newProjectDir, "sessions-index.json");
    if (fs.existsSync(sessionsIndex)) {
        let content = fs.readFileSync(sessionsIndex, "utf-8");
        content = content.replace(new RegExp(oldDirName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), newDirName);
        content = content.replace(new RegExp(`"${oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g"), `"${newPath}"`);
        fs.writeFileSync(sessionsIndex, content);
        sessionsIndexUpdated = true;
    }

    // Fix global history.jsonl
    let historyFileUpdated = false;
    if (fs.existsSync(HISTORY_FILE)) {
        let content = fs.readFileSync(HISTORY_FILE, "utf-8");
        const oldRef = `"${oldPath}"`;
        if (content.includes(oldRef)) {
            content = content.replace(new RegExp(oldRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), `"${newPath}"`);
            fs.writeFileSync(HISTORY_FILE, content);
            historyFileUpdated = true;
        }
    }

    // Clean broken resume artifacts
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
